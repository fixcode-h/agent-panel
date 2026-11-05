import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Copy, Loader2, RotateCw, Square, X } from 'lucide-react'
import { t } from '@shared/i18n'
import {
  EVENT_KINDS,
  eventKind,
  parseLogLine,
  type Anomaly,
  type EventKind,
  type LifeNode,
  type LogLine,
} from '@shared/lifecycle'
import { convStateText, resumable, stopReasonText, type ConvState } from '@shared/task'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import { fmtDuration } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { IconButton } from '@/components/ui/icon-button'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { ReminderTrail } from './ReminderTrail'

/**
 * 状态诊断右边那一栏（LifecycleDialog 里选中的节点）：结论、异常、六类事件的计数、执行 / 模型 / 进程三张卡、日志。
 * 计数由服务端按完整日志算好（shared/lifecycle.ts 的 countEvents），点一块就只看那一类日志
 */

/** 异常里最重的一级：树上的小标记和详情的配色都按它 */
export function worst(list: Anomaly[]) {
  return list.some((a) => a.level === 'danger') ? 'danger' : list.some((a) => a.level === 'warning') ? 'warning' : ''
}

const KIND_TEXT = { conversation: t('对话'), helper: t('子任务'), node: t('工作流节点') } as const

export const STATE_TONE: Record<ConvState, StatusTone> = {
  running: 'run',
  waiting: 'wait',
  needs: 'wait',
  wrapup: 'run',
  unfinished: 'wait',
  failed: 'err',
  stopped: 'idle',
  done: 'ok',
}

/** 六类事件的名字和有数时的颜色（出错红、重试黄，其余是普通的前景色） */
const COUNT_META: Record<EventKind, { label: string; tone: string }> = {
  requests: { label: t('模型请求'), tone: 'text-fg' },
  // 面板推了几次「接着做」（结束前钩子拦住、一轮结束后补发）：不限次数，逐条记录在下面的「面板提醒」卡片里
  nudges: { label: t('面板提醒'), tone: 'text-fg' },
  retries: { label: t('重试'), tone: 'text-warning' },
  errors: { label: t('出错'), tone: 'text-danger' },
  stops: { label: t('停止'), tone: 'text-fg' },
  exits: { label: t('进程退出'), tone: 'text-fg' },
}

/** 状态胶囊、树上那句状态的颜色：和 StatusPill 的几种状态色同一套（运行青、完成绿、等你琥珀、失败红、停着灰） */
export const TONE_TEXT: Record<StatusTone, string> = {
  run: 'text-run',
  ok: 'text-success',
  wait: 'text-warning',
  err: 'text-danger',
  idle: 'text-subtle',
}

/** 节点的对外状态：对话用 convState，子任务按步骤状态折算（被打断算停着） */
export function nodeState(node: LifeNode): ConvState {
  const f = node.facts
  if (f.state) return f.state
  if (f.interrupted) return 'stopped'
  return f.status === 'running'
    ? 'running'
    : f.status === 'failed'
      ? 'failed'
      : f.status === 'stopped'
        ? 'stopped'
        : 'done'
}

/**
 * 对话的停止 / 重启：在执行就给「停止」（和任务页的停止同一个接口，按对话树自上而下停），
 * 停了或失败了给「重启」（就是任务页的「继续执行」，接着原来的会话跑）。点完不等结果，弹窗每 2 秒刷新会跟上
 */
function RunControl({ node }: { node: LifeNode }) {
  const [busy, setBusy] = useState(false)
  const f = node.facts
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (f.status === 'running') {
    const stopping = !!f.live?.stop
    return (
      <Button
        size="sm"
        variant="danger-outline"
        className="h-7"
        disabled={busy || stopping}
        onClick={() => void run(() => api.stopTask(node.taskId))}
        data-life-stop
      >
        {busy || stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3" />}
        {stopping ? t('正在停止') : t('停止')}
      </Button>
    )
  }
  if (!resumable(f.status)) return null
  return (
    <Button
      size="sm"
      variant="secondary"
      className="h-7"
      disabled={busy}
      title={t('接着原来的会话继续执行')}
      onClick={() => void run(() => api.resumeTask(node.taskId))}
      data-life-resume
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
      {t('重启')}
    </Button>
  )
}

/** 日志的筛选：全部、关键事件（面板提醒、重试、出错、停止、退出），或者点计数块选的某一类 */
type LogFilter = '' | 'key' | EventKind

export function LifeDetail({ node, parent }: { node: LifeNode; parent?: LifeNode }) {
  const now = useNow(true)
  const [filter, setFilter] = useState<LogFilter>('')
  const f = node.facts
  const level = worst(node.verdict.anomalies)
  const state = nodeState(node)
  const ago = (ms?: number | null) => (ms ? t('{d} 前', { d: fmtDuration(Math.max(0, now - ms)) }) : '—')
  const lines = useMemo(() => node.log.map((raw) => ({ raw, l: parseLogLine(raw) })), [node.log])
  return (
    <section
      aria-label={t('生命周期')}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
    >
      <header className="flex flex-col gap-1.5">
        <span className="truncate text-footnote text-subtle">
          {KIND_TEXT[node.kind]}
          {parent && <> · {t('属于「{title}」', { title: parent.title })}</>}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-heading font-medium text-fg">{node.title || node.id}</h3>
          {state && (
            <StatusPill tone={STATE_TONE[state]} spin={f.working}>
              {convStateText(state)}
            </StatusPill>
          )}
          <span className="flex-1" />
          {node.kind === 'conversation' && <RunControl node={node} />}
        </div>
        <p
          data-life-headline
          className={cn(
            'text-body',
            level === 'danger' ? 'text-danger' : level === 'warning' ? 'text-warning' : 'text-muted',
          )}
        >
          {node.verdict.headline}
        </p>
      </header>

      {node.verdict.anomalies.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={t('异常')}>
          {node.verdict.anomalies.map((a) => (
            <li
              key={a.code}
              className={cn(
                'flex items-baseline gap-2 rounded-lg px-3 py-2 text-body',
                a.level === 'danger'
                  ? 'bg-danger/8 text-danger'
                  : a.level === 'warning'
                    ? 'bg-warning/8 text-warning'
                    : 'bg-sel text-muted',
              )}
            >
              <span className="min-w-0 flex-1">{a.text}</span>
              <code className="shrink-0 font-mono text-caption opacity-70">{a.code}</code>
            </li>
          ))}
        </ul>
      )}

      {node.counts && (
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
          aria-label={t('事件计数')}
          data-life-counts
        >
          {EVENT_KINDS.map((k) => {
            const c = node.counts![k]
            const on = filter === k
            return (
              <Card
                key={k}
                as="button"
                interactive
                aria-pressed={on}
                onClick={() => setFilter(on ? '' : k)}
                title={c.last ? c.last.text : undefined}
                className={cn('flex min-w-0 flex-col gap-0.5 px-3 py-2', on && 'ring-1 ring-accent ring-inset')}
              >
                <span className="text-footnote text-subtle">{COUNT_META[k].label}</span>
                <span
                  className={cn(
                    'text-title font-semibold tabular-nums',
                    c.n ? COUNT_META[k].tone : 'font-normal text-subtle',
                  )}
                >
                  {c.n}
                </span>
                <span className="truncate text-caption text-subtle">{c.last ? ago(c.last.at) : t('这次运行没有')}</span>
              </Card>
            )
          })}
        </div>
      )}

      <div className="grid gap-2 lg:grid-cols-3">
        <InfoCard
          title={t('执行')}
          rows={[
            [
              t('执行位'),
              f.live
                ? f.live.stop
                  ? t('正在停下（{why}）', { why: stopReasonText(f.live.stopReason) })
                  : t('占着')
                : t('空'),
            ],
            [t('排着的消息'), String(f.held)],
            [t('子任务 / 后台命令'), `${f.helpers} / ${f.jobs}`],
            ...(f.stopReason ? [[t('停止原因'), stopReasonText(f.stopReason)] as [string, string]] : []),
            ...(node.viewer
              ? [
                  [
                    t('页面'),
                    node.viewer.viewing ? t('开着') : node.viewer.watched ? t('切走了（宽限期里）') : t('没人在看'),
                  ] as [string, string],
                ]
              : []),
            ...(node.reruns ? [[t('重跑次数'), String(node.reruns)] as [string, string]] : []),
          ]}
        />
        <ModelCard node={node} now={now} lines={lines} />
        <ProcessCard node={node} now={now} />
      </div>

      {node.trail && node.trail.length > 0 && <ReminderTrail items={node.trail} />}

      <LifeLog lines={lines} filter={filter} setFilter={setFilter} />
    </section>
  )
}

function InfoCard({ title, rows, children }: { title: string; rows: [string, string][]; children?: React.ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col gap-2 px-3.5 py-3">
      <span className="text-footnote text-subtle">{title}</span>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-subtle">{k}</dt>
            <dd className="truncate text-right text-fg tabular-nums" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {children}
    </Card>
  )
}

type Parsed = { raw: string; l?: LogLine }

/** 模型卡：请求次数、首字等待、最后输出，外加最近 12 次首字等待的小柱子（网关忽快忽慢一眼看出） */
function ModelCard({ node, now, lines }: { node: LifeNode; now: number; lines: Parsed[] }) {
  const tr = node.facts.trace
  const waits = lines
    .filter((x) => x.l?.event === '模型开始输出' && x.l.fields.waitedMs)
    .map((x) => Number(x.l!.fields.waitedMs))
    .slice(-12)
  // 这一次请求还没回：最后补一根「还在等」的柱子，高度按已经等了多久
  const pending = tr?.requestAt && !tr.firstOutputAt ? now - tr.requestAt : 0
  const bars = pending ? [...waits.slice(-11), pending] : waits
  const max = Math.max(1, ...bars)
  const wait = tr?.requestAt && tr.firstOutputAt ? fmtDuration(tr.firstOutputAt - tr.requestAt) : ''
  return (
    <InfoCard
      title={t('模型')}
      rows={[
        ...(node.cli || node.model
          ? [[t('CLI / 模型'), [node.cli, node.model].filter(Boolean).join(' · ')] as [string, string]]
          : []),
        [t('这一轮'), tr ? t('第 {n} 次请求', { n: tr.requests }) : t('没有记录')],
        [t('首字等待'), wait || (pending ? t('还没回（已等 {d}）', { d: fmtDuration(pending) }) : '—')],
        [
          t('最后输出'),
          tr?.lastOutputAt
            ? now - tr.lastOutputAt < 2000
              ? t('刚刚')
              : t('{d} 前', { d: fmtDuration(now - tr.lastOutputAt) })
            : '—',
        ],
        ...(tr?.retry
          ? [
              [t('重试'), t('第 {n} 次：{error}', { n: tr.retry.attempt, error: tr.retry.error ?? '' })] as [
                string,
                string,
              ],
            ]
          : []),
      ]}
    >
      {bars.length > 1 && (
        <div className="mt-auto flex flex-col gap-1" title={t('最近几次请求的首字等待')}>
          <div className="flex h-7 items-end gap-0.5">
            {bars.map((ms, i) => {
              const last = pending && i === bars.length - 1
              return (
                <span
                  key={i}
                  title={last ? t('还没回（已等 {d}）', { d: fmtDuration(ms) }) : fmtDuration(ms)}
                  // 开方压一压：一次 30 秒的慢请求不至于把其余几百毫秒的柱子压成一条线
                  style={{ height: `${Math.max(8, (Math.sqrt(ms) / Math.sqrt(max)) * 100)}%` }}
                  className={cn(
                    'min-w-0 flex-1 rounded-t-[2px]',
                    last ? 'animate-pulse bg-warning' : ms > 10_000 ? 'bg-warning' : 'bg-accent/55',
                  )}
                />
              )
            })}
          </div>
          <span className="flex justify-between text-caption text-subtle">
            <span>{t('首字等待 · 最近 {n} 次', { n: bars.length })}</span>
            <span className="tabular-nums">{t('最长 {d}', { d: fmtDuration(max) })}</span>
          </span>
        </div>
      )}
    </InfoCard>
  )
}

/** 进程卡：活着时给 PID、运行多久、内存和命令；不在了写为什么 */
function ProcessCard({ node, now }: { node: LifeNode; now: number }) {
  const p = node.processes[0]
  const copy = (text: string) => void copyText(text, { done: t('已复制'), fail: false })
  return (
    <Card className="flex min-w-0 flex-col gap-2 px-3.5 py-3">
      <span className="flex items-center justify-between text-footnote text-subtle">
        {t('进程')}
        <span className={cn('inline-flex items-center gap-1.5', node.facts.cliAlive ? 'text-success' : 'text-subtle')}>
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              node.facts.cliAlive ? 'bg-success' : 'ring-1 ring-line-strong ring-inset',
            )}
          />
          {node.facts.cliAlive ? t('活着') : t('不在')}
        </span>
      </span>
      {p ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
          <dt className="text-subtle">PID</dt>
          <dd className="text-right font-mono text-footnote leading-5 text-fg">
            {node.processes.map((x) => x.pid).join('、')}
          </dd>
          <dt className="text-subtle">{t('已运行')}</dt>
          <dd className="text-right text-fg tabular-nums">
            {p.startedAt ? fmtDuration(Math.max(0, now - p.startedAt)) : '—'}
          </dd>
          <dt className="text-subtle">{t('内存')}</dt>
          <dd className="text-right text-fg tabular-nums">{p.rss ? `${Math.round(p.rss / 1048576)} MB` : '—'}</dd>
        </dl>
      ) : (
        <p className="text-body text-muted">
          {node.facts.cliAlive ? t('登记着活着，进程表里还没读到') : node.verdict.why || t('不在')}
        </p>
      )}
      {(
        [
          [t('命令'), p?.command],
          [t('会话'), node.session],
        ] as const
      )
        .filter(([, v]) => !!v)
        .map(([k, v]) => (
          <div key={k} className="flex min-w-0 items-center gap-1.5 rounded-md bg-sel/60 py-0.5 pr-0.5 pl-2">
            <span className="shrink-0 text-caption text-subtle">{k}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={v}>
              {v}
            </span>
            <IconButton icon={Copy} label={t('复制{what}', { what: k })} size="2xs" onClick={() => copy(v!)} />
          </div>
        ))}
    </Card>
  )
}

/** 日志行的配色类：六类事件之外，模型开始输出、进程启动也单独上色 */
function lineTone(l?: LogLine) {
  if (!l) return ''
  const k = eventKind(l.event, l.fields)
  if (k === 'errors') return 'bg-danger/12 text-danger'
  if (k === 'retries') return 'bg-warning/12 text-warning'
  if (k === 'stops' || k === 'exits' || l.event === 'CLI 进程启动') return 'bg-run-soft text-run'
  if (k === 'nudges' || l.event === '模型开始输出') return 'bg-accent/12 text-accent-text'
  return 'bg-sel text-muted'
}

type Row =
  | { kind: 'line'; raw: string; l?: LogLine }
  | { kind: 'pair'; req: LogLine; out: LogLine }
  | { kind: 'day'; day: string }

/** 筛选、合并「请求开始 + 开始输出」、按天插分隔 */
function buildRows(lines: Parsed[], filter: LogFilter, merge: boolean): Row[] {
  const keep = (x: Parsed) => {
    if (!filter) return true
    if (!x.l) return false
    const k = eventKind(x.l.event, x.l.fields)
    if (filter === 'key') return !!k && k !== 'requests'
    if (filter === 'requests') return k === 'requests' || x.l.event === '模型开始输出'
    return k === filter
  }
  const list = lines.filter(keep)
  const out: Row[] = []
  let day = ''
  for (let i = 0; i < list.length; i++) {
    const { raw, l } = list[i]
    const d = raw.slice(0, 10)
    if (l && d !== day) {
      day = d
      out.push({ kind: 'day', day: d })
    }
    const nx = list[i + 1]?.l
    if (
      merge &&
      l?.event === '模型请求开始' &&
      nx?.event === '模型开始输出' &&
      nx.fields.n === l.fields.n &&
      (nx.fields.step ?? '') === (l.fields.step ?? '')
    ) {
      out.push({ kind: 'pair', req: l, out: nx })
      i++
    } else out.push({ kind: 'line', raw, l })
  }
  return out
}

const FIELD_SKIP = new Set(['step'])

function Fields({ l }: { l: LogLine }) {
  const kv = Object.entries(l.fields).filter(([k]) => !FIELD_SKIP.has(k))
  return (
    <span className="min-w-0 flex-1 truncate text-muted" title={l.raw}>
      {kv.map(([k, v]) => (
        <span key={k} className="mr-2">
          <span className="text-subtle">{k}=</span>
          {v}
        </span>
      ))}
    </span>
  )
}

function LifeLog({
  lines,
  filter,
  setFilter,
}: {
  lines: Parsed[]
  filter: LogFilter
  setFilter: (f: LogFilter) => void
}) {
  const [merge, setMerge] = useState(true)
  // 跟随最新：默认贴着底；往上翻看时停住，底下出「跳到最新」，翻回底部又自动跟上
  const [follow, setFollow] = useState(true)
  const box = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => buildRows(lines, filter, merge), [lines, filter, merge])
  useLayoutEffect(() => {
    const el = box.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [rows, follow])
  const onScroll = () => {
    const el = box.current
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }
  const kindLabel = filter && filter !== 'key' ? COUNT_META[filter].label : ''
  return (
    <Card className="relative flex min-h-[260px] flex-1 flex-col overflow-hidden" data-life-log>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3.5 py-2 text-footnote text-subtle">
        <span className="tabular-nums">{t('日志 · 最近 {n} 条', { n: lines.length })}</span>
        {kindLabel && (
          <button
            type="button"
            onClick={() => setFilter('')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-sel px-1.5 text-muted hover:text-fg"
          >
            {t('只看「{kind}」', { kind: kindLabel })}
            <X className="h-3 w-3" />
          </button>
        )}
        <span className="flex-1" />
        <label className="inline-flex cursor-pointer items-center gap-2">
          <Switch checked={filter === 'key'} onCheckedChange={(v) => setFilter(v ? 'key' : '')} />
          {t('只看关键事件')}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <Switch checked={merge} onCheckedChange={setMerge} />
          {t('合并请求')}
        </label>
      </div>
      <div
        ref={box}
        onScroll={onScroll}
        // 行与行之间一道细线（divide-y，和各页列表的分割线一样），每行上下留空：
        // 事件标签各自是一小块，不会上下连成一片（用户 2026-11-02 指出背景连到一起）
        className="min-h-0 flex-1 divide-y overflow-y-auto font-mono text-footnote leading-5"
      >
        {rows.length === 0 && <p className="px-3.5 py-6 text-center font-sans text-subtle">{t('没有这类事件')}</p>}
        {rows.map((r, i) =>
          r.kind === 'day' ? (
            <div key={i} className="px-3.5 pt-2.5 pb-1.5 font-sans text-caption text-subtle">
              {r.day}
            </div>
          ) : r.kind === 'pair' ? (
            <div key={i} className="flex min-w-0 items-center gap-3 px-3.5 py-1.5 hover:bg-hover">
              <span className="shrink-0 text-subtle">{r.req.raw.slice(11, 23)}</span>
              <span className="w-28 shrink-0">
                <span className="rounded-sm bg-accent/12 px-1.5 py-px font-sans text-caption text-accent-text">
                  {t('模型请求 #{n}', { n: r.req.fields.n ?? '?' })}
                </span>
              </span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {t('{d} 后开始输出', { d: fmtDuration(Number(r.out.fields.waitedMs) || 0) })}
                {r.out.fields.kind && <span className="text-subtle"> · {r.out.fields.kind}</span>}
              </span>
            </div>
          ) : (
            <div key={i} className="flex min-w-0 items-center gap-3 px-3.5 py-1.5 hover:bg-hover">
              {r.l ? (
                <>
                  <span className="shrink-0 text-subtle">{r.raw.slice(11, 23)}</span>
                  <span className="w-28 shrink-0">
                    <span
                      className={cn(
                        'inline-block max-w-full truncate rounded-sm px-1.5 py-px align-middle font-sans text-caption',
                        lineTone(r.l),
                      )}
                      title={r.l.event}
                    >
                      {r.l.event}
                    </span>
                  </span>
                  <Fields l={r.l} />
                </>
              ) : (
                <span className="min-w-0 truncate pl-[calc(5.5rem+0.75rem)] text-subtle">{r.raw}</span>
              )}
            </div>
          ),
        )}
      </div>
      {!follow && (
        <button
          type="button"
          onClick={() => setFollow(true)}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border border-line-strong bg-card px-2.5 py-0.5 text-footnote text-muted shadow-pop hover:text-fg"
        >
          <ArrowDown className="h-3 w-3" />
          {t('跳到最新')}
        </button>
      )}
    </Card>
  )
}
