import { useCallback, useEffect, useState } from 'react'
import * as P from '@radix-ui/react-popover'
import { Activity, Loader2, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { popoverPanel } from '@/components/ui/menu'
import { api } from '@/lib/api'
import { MB, fmtMem } from '@/lib/mem'
import { fmtDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import type { TaskProcess, TaskProcesses } from '@shared/schema'

/** 下拉按钮上的状态点：没有数据时不画，有孤儿进程是黄，内存占用高是红 */
type Dot = 'none' | 'ok' | 'warn' | 'bad'

/**
 * 面板进程列表的内存阈值：浏览器里拿不到本机总内存，用固定值判断「占用高」。
 * 3 GB 以上的对话进程基本是哪里卡住了，值得标红让用户点开看
 */
const HIGH_MEMORY = 3 * MB
/** 展开时的刷新间隔：进程会在几秒内结束，5 秒够近，也不会把系统进程表拉得太频繁 */
const REFRESH_MS = 5000

function dotOf(d: TaskProcesses | null): Dot {
  if (!d) return 'none'
  if (d.processes.some((p) => p.status === 'orphan')) return 'warn'
  if ((d.totalMemory ?? 0) > HIGH_MEMORY) return 'bad'
  return 'ok'
}

const dotClass: Record<Exclude<Dot, 'none'>, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
}

const statusText = (s: TaskProcess['status']) =>
  s === 'orphan' ? t('任务已结束') : s === 'idle' ? t('很久没输出') : t('运行中')

/**
 * 标题旁的「对话进程」下拉：图标常驻，面板内容只在展开时挂载。
 * 收起时整块不渲染、不请求、不轮询（Popover 的内容加上 open 判断，DOM 里连节点都没有）
 */
export function ProcessMenu({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false)
  // 状态点是最后一次展开时算出来的结论：收起后不再发请求，只把颜色留在按钮上
  const [dot, setDot] = useState<Dot>('none')
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('对话进程')}
          aria-expanded={open}
          title={t('对话进程')}
          className="relative shrink-0"
        >
          <Activity className="h-4 w-4" />
          {dot !== 'none' && (
            <span aria-hidden className={cn('absolute top-1 right-1 h-1.5 w-1.5 rounded-full', dotClass[dot])} />
          )}
        </Button>
      </P.Trigger>
      <P.Portal>
        <P.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          // 打开时不抢焦点：面板里第一下点击应该是用户要点的那个按钮
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(popoverPanel, 'w-[min(440px,calc(100vw-16px))] p-0')}
        >
          {open && <ProcessPanelBody taskId={taskId} onDot={setDot} />}
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}

type Confirm = { kind: 'kill'; proc: TaskProcess } | { kind: 'clean'; items: TaskProcess[]; ai: boolean } | null

function ProcessPanelBody({ taskId, onDot }: { taskId: string; onDot: (d: Dot) => void }) {
  const [tab, setTab] = useState<'processes' | 'memory'>('processes')
  const [data, setData] = useState<TaskProcesses | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestText, setSuggestText] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await api.taskProcesses(taskId)
      setData(d)
      setError('')
      onDot(dotOf(d))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [taskId, onDot])

  // 只在进程页轮询：切到内存曲线时不拉进程列表，收起时随组件卸载一起清掉
  useEffect(() => {
    if (tab !== 'processes') return
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [load, tab])

  const kill = async (pid: number) => {
    setBusy(true)
    try {
      const r = await api.killTaskProcess(taskId, pid)
      setConfirm(null)
      // 没结束（权限不足、被系统占用）时把真实原因留在面板上，不要显示成「已关闭」
      if (!r.ok) setError(r.error || t('没有结束这个进程'))
      await load()
    } catch (e) {
      // 系统给的真实错误原样显示（权限不足、进程已经结束等）
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const clean = async (pids: number[]) => {
    setBusy(true)
    try {
      const r = await api.cleanTaskProcesses(taskId, pids)
      setConfirm(null)
      setSuggestText('')
      if (r.skipped.length)
        setError(r.skipped.map((x) => t('{pid}：{reason}', { pid: x.pid, reason: x.reason })).join('；'))
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const suggest = async () => {
    setSuggesting(true)
    setError('')
    try {
      const r = await api.suggestTaskProcesses(taskId)
      if (r.error) setError(r.error)
      setSuggestText(r.text)
      const items = r.suggestions
        .map((s) => data?.processes.find((p) => p.pid === s.pid))
        .filter((p): p is TaskProcess => !!p)
      // 建议里只有 pid 没有匹配上的进程（已经结束）时也照实说明
      if (!items.length && r.suggestions.length) setError(t('建议清理的进程已经不在了'))
      if (items.length) setConfirm({ kind: 'clean', items, ai: true })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSuggesting(false)
    }
  }

  const orphans = (data?.processes ?? []).filter((p) => p.status === 'orphan' && p.kind === 'cli')

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {(
          [
            ['processes', t('进程')],
            ['memory', t('内存曲线')],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            aria-pressed={tab === v}
            onClick={() => setTab(v)}
            className={cn(
              'h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium',
              tab === v ? 'bg-sel text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={t('刷新')}
          title={t('刷新')}
          onClick={() => void load()}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        </Button>
      </div>

      {error && (
        <p className="border-b border-line bg-danger/8 px-3 py-2 text-[0.75rem] leading-relaxed text-danger">{error}</p>
      )}

      {tab === 'processes' ? (
        <>
          <div className="border-b border-line px-3 py-2 text-[0.75rem] leading-relaxed">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted">{t('内存合计')}</span>
              <span className="font-medium tabular-nums">{fmtMem(data?.totalMemory ?? null)}</span>
            </div>
            <p className="mt-0.5 text-[0.6875rem] text-subtle">
              {t('面板 {server} · 进程 {cli}', {
                server: fmtMem(data?.serverMemory ?? null),
                cli: fmtMem(data?.cliMemory ?? null),
              })}
              {data?.unavailable ? ` · ${data.unavailable}` : ''}
            </p>
          </div>

          {confirm ? (
            <ConfirmView
              confirm={confirm}
              busy={busy}
              onCancel={() => {
                setConfirm(null)
                setSuggestText('')
              }}
              onKill={kill}
              onClean={clean}
            />
          ) : (
            <>
              <div className="max-h-[46vh] overflow-y-auto py-1">
                {!data ? (
                  <p className="px-3 py-6 text-center text-[0.75rem] text-subtle">{t('正在读取进程…')}</p>
                ) : data.processes.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[0.75rem] text-subtle">{t('这个对话现在没有在跑的进程')}</p>
                ) : (
                  data.processes.map((p) => (
                    <ProcessRow
                      key={p.pid}
                      proc={p}
                      disabled={busy}
                      onKill={() => setConfirm({ kind: 'kill', proc: p })}
                    />
                  ))
                )}
              </div>
              <div className="flex items-center gap-2 border-t border-line px-2 py-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !orphans.length}
                  title={orphans.length ? t('清理任务已经结束、进程还留着的') : t('没有可清理的进程')}
                  onClick={() => setConfirm({ kind: 'clean', items: orphans, ai: false })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('清理无效进程')}
                  {orphans.length ? ` (${orphans.length})` : ''}
                </Button>
                <Button variant="ghost" size="sm" className="ml-auto" disabled={busy || suggesting} onClick={suggest}>
                  {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {t('AI 清理')}
                </Button>
              </div>
              {suggestText && (
                <p className="max-h-24 overflow-y-auto border-t border-line px-3 py-2 text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-muted">
                  {suggestText}
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <div className="px-3 py-6 text-center text-[0.75rem] text-subtle">{t('还没有内存采样，30 秒后开始记录')}</div>
      )}
    </div>
  )
}

function ProcessRow({ proc, disabled, onKill }: { proc: TaskProcess; disabled: boolean; onKill: () => void }) {
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-sel/60">
      <span
        aria-hidden
        className={cn(
          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
          proc.status === 'running' ? 'bg-success' : proc.status === 'idle' ? 'bg-warning' : 'bg-subtle',
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.75rem]" title={proc.command}>
          {proc.command || t('（没有命令行）')}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem] text-subtle">
          {proc.ownerTitle && <span className="max-w-[45%] truncate text-muted">{proc.ownerTitle}</span>}
          <span>{proc.kind === 'child' ? t('子进程') : t('CLI')}</span>
          <span>·</span>
          <span className="tabular-nums">{proc.durationMs === null ? t('未知') : fmtDuration(proc.durationMs)}</span>
          <span>·</span>
          <span className="tabular-nums">{fmtMem(proc.rss)}</span>
          <span>·</span>
          <span>{statusText(proc.status)}</span>
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        disabled={disabled}
        onClick={onKill}
        aria-label={t('关闭进程 {pid}', { pid: proc.pid })}
      >
        {t('关闭')}
      </Button>
    </div>
  )
}

/** 二次确认放在面板里做：弹窗套在 Popover 上会互相抢焦点，点弹窗还会先把下拉关掉 */
function ConfirmView({
  confirm,
  busy,
  onCancel,
  onKill,
  onClean,
}: {
  confirm: NonNullable<Confirm>
  busy: boolean
  onCancel: () => void
  onKill: (pid: number) => Promise<void>
  onClean: (pids: number[]) => Promise<void>
}) {
  const items = confirm.kind === 'kill' ? [confirm.proc] : confirm.items
  const title =
    confirm.kind === 'kill'
      ? t('关闭这个进程？')
      : confirm.ai
        ? t('按 AI 的建议清理这 {n} 个进程？', { n: items.length })
        : t('清理这 {n} 个无效进程？', { n: items.length })
  return (
    <div className="flex flex-col">
      <div className="px-3 py-2">
        <p className="text-[0.8125rem] font-medium">{title}</p>
        <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
          {confirm.kind === 'kill'
            ? t('进程会被直接结束，它正在做的事会中断。')
            : t('只清理面板登记的、任务已经结束的进程；用户自己开的终端进程不在列表里。')}
        </p>
        <ul className="mt-1.5 max-h-[30vh] space-y-1 overflow-y-auto">
          {items.map((p) => (
            <li key={p.pid} className="truncate text-[0.6875rem] text-muted" title={p.command}>
              {p.pid} · {p.ownerTitle || t('面板')} · {p.command}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-2 py-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          {t('取消')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={busy || !items.length}
          onClick={() =>
            void (confirm.kind === 'kill'
              ? onKill(confirm.proc.pid)
              : onClean(items.filter((p) => p.kind === 'cli').map((p) => p.pid)))
          }
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {confirm.kind === 'kill' ? t('关闭') : t('清理')}
        </Button>
      </div>
    </div>
  )
}
