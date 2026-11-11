import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, Square, Terminal, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { exportName, type ExportEvent, type TableExport } from '@shared/table-export'
import { tablesApi } from '@/lib/tables-api'
import { copyText } from '@/lib/copy-text'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { useNow } from '@/lib/useNow'
import { fmtDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { Select } from '@/components/ui/input'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { StatusPill } from '@/components/ui/status-pill'

/** 每条命令最多留这么多行输出：导几千张表时输出很长，只看结尾，页面不卡 */
const KEEP_LINES = 3000
/** 输出面板最多留最近这么多次执行 */
export const KEEP_RUNS = 20

/** 一次导表：第几个脚本、导哪些表 */
export interface ExportRunInfo {
  id: number
  index: number
  script: TableExport
  paths: string[]
  dirty: number
  at: number
}

interface Step {
  line: string
  out: string[]
  /** 前面丢掉了多少行 */
  dropped: number
  code?: number | null
  killed?: string
  error?: string
  ended: boolean
}

export type Phase = 'running' | 'done' | 'failed' | 'stopped'

const PHASE_LABEL = () => ({ running: t('执行中'), done: t('完成'), failed: t('失败'), stopped: t('已停止') })

/**
 * 表格页底部的「输出」面板（不再是全屏弹窗）：导表时自动展开，能拖高、收起；留着最近 20 次执行，下拉切换着看。
 * 每次执行一直挂着（看别的那次时只是藏起来），所以在跑的不会因为切走被停掉；关掉面板才停
 */
export function TableOutputPanel({
  projectId,
  runs,
  current,
  onCurrent,
  open,
  onOpen,
  onClose,
}: {
  projectId: string
  runs: ExportRunInfo[]
  current: number
  onCurrent: (id: number) => void
  /** 展开着（收起时只剩标题一条） */
  open: boolean
  onOpen: (v: boolean) => void
  /** 关掉面板：停掉还在跑的、清掉历史 */
  onClose: () => void
}) {
  const pane = usePaneWidth('tables-output', 260, 120, () => Math.round(window.innerHeight * 0.7))
  const [phases, setPhases] = useState<Record<number, Phase>>({})
  const cur = runs.find((r) => r.id === current) ?? runs[runs.length - 1]
  const labels = PHASE_LABEL()
  return (
    <section
      aria-label={t('输出')}
      style={{ height: open ? pane.width : undefined }}
      className="relative flex shrink-0 flex-col border-t bg-panel"
    >
      {open && <ResizeHandle pane={pane} side="top" />}
      <header className="flex h-8 shrink-0 items-center gap-2 px-3 text-footnote">
        <Terminal className="h-3.5 w-3.5 text-subtle" />
        <span className="font-medium">{t('输出')}</span>
        {runs.length > 1 ? (
          <Select
            size="xs"
            aria-label={t('第几次执行')}
            className="w-auto max-w-[360px]"
            value={String(cur?.id ?? '')}
            onChange={(e) => onCurrent(Number(e.target.value))}
            options={[...runs].reverse().map((r) => ({
              value: String(r.id),
              label: `${exportName(r.script, r.index)} · ${new Date(r.at).toLocaleTimeString()} · ${labels[phases[r.id] ?? 'running']}`,
            }))}
          />
        ) : (
          cur && <span className="min-w-0 truncate text-muted">{exportName(cur.script, cur.index)}</span>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <IconButton
            icon={open ? ChevronDown : ChevronUp}
            size="xs"
            label={open ? t('收起') : t('展开')}
            onClick={() => onOpen(!open)}
          />
          <IconButton icon={X} size="xs" label={t('关闭输出（停掉还在跑的）')} onClick={onClose} />
        </span>
      </header>
      {runs.map((r) => (
        <ExportRun
          key={r.id}
          projectId={projectId}
          run={r}
          hidden={!open || r.id !== cur?.id}
          onPhase={(ph) => setPhases((m) => (m[r.id] === ph ? m : { ...m, [r.id]: ph }))}
        />
      ))}
    </section>
  )
}

/** 一次执行：一挂上就开始跑，像终端一样逐条显示命令（占位已换成真实路径）和输出；一条失败后面的不再跑 */
function ExportRun({
  projectId,
  run,
  hidden,
  onPhase,
}: {
  projectId: string
  run: ExportRunInfo
  hidden: boolean
  onPhase: (p: Phase) => void
}) {
  const { index, script, paths, dirty } = run
  const [steps, setSteps] = useState<Step[]>([])
  const [phase, setPhase] = useState<Phase>('running')
  const [error, setError] = useState('')
  const [startedAt] = useState(() => Date.now())
  const [ms, setMs] = useState<number>()
  const abort = useRef<AbortController | null>(null)
  const now = useNow(phase === 'running')

  useEffect(() => {
    const ac = new AbortController()
    abort.current = ac
    // 输出一行一行来：攒到下一帧一起更新，几千行一下涌进来时不每行渲染一次
    let queue: ExportEvent[] = []
    let frame = 0
    const flush = () => {
      frame = 0
      const batch = queue
      queue = []
      setSteps((cur) => {
        const next = [...cur]
        for (const e of batch) {
          if (e.type === 'start') next[e.index] = { line: e.line, out: [], dropped: 0, ended: false }
          else if (e.type === 'out' && next.length) {
            const s = { ...next[next.length - 1] }
            s.out = [...s.out, e.text]
            if (s.out.length > KEEP_LINES) {
              s.dropped += s.out.length - KEEP_LINES
              s.out = s.out.slice(-KEEP_LINES)
            }
            next[next.length - 1] = s
          } else if (e.type === 'end') {
            if (e.index < 0) setError(e.error ?? '')
            else if (next[e.index])
              next[e.index] = { ...next[e.index], code: e.code, killed: e.killed, error: e.error, ended: true }
          }
        }
        return next
      })
      for (const e of batch)
        if (e.type === 'done') {
          setPhase(e.ok ? 'done' : 'failed')
          setMs(Date.now() - startedAt)
        }
    }
    tablesApi
      .runExport(
        projectId,
        index,
        paths,
        (e) => {
          queue.push(e)
          if (!frame) frame = requestAnimationFrame(flush)
        },
        ac.signal,
      )
      .catch((e) => {
        if (ac.signal.aborted) return
        setError((e as Error).message)
        setPhase('failed')
      })
    return () => {
      ac.abort()
      if (frame) cancelAnimationFrame(frame)
    }
    // 挂上时跑一次；再导一次是新的一次执行
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // onPhase 每次渲染都是新函数：只在 phase 变了时报
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onPhase(phase), [phase])

  const stop = () => {
    abort.current?.abort()
    setPhase('stopped')
    setMs(Date.now() - startedAt)
  }
  const stick = useStickToBottom(steps.length)
  const all = steps.map((s) => `$ ${s.line}\n${s.out.join('\n')}`).join('\n\n')
  const tone = phase === 'running' ? 'run' : phase === 'done' ? 'ok' : phase === 'failed' ? 'err' : 'idle'
  const label = PHASE_LABEL()[phase]
  const elapsed = phase === 'running' ? now - startedAt : ms
  return (
    <div className={cn('min-h-0 flex-1 flex-col', hidden ? 'hidden' : 'flex')}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-t px-3 text-footnote">
        <StatusPill tone={tone} className="h-5 shrink-0 px-2 font-sans">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              { run: 'animate-pulse bg-run', ok: 'bg-success', err: 'bg-danger', idle: 'bg-subtle' }[tone],
            )}
          />
          {label}
          {steps.length > 1 && (
            <span className="tabular-nums opacity-80">
              {steps.filter((s) => s.ended).length}/{steps.length}
            </span>
          )}
          {elapsed !== undefined && <span className="tabular-nums opacity-80">{fmtDuration(elapsed)}</span>}
        </StatusPill>
        <span className="min-w-0 truncate font-mono text-caption text-subtle" title={paths.join('\n')}>
          {paths.length === 1 ? paths[0] : t('{n} 张表', { n: paths.length })}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {phase === 'running' && <IconButton icon={Square} size="xs" label={t('停止')} onClick={stop} />}
          <IconButton
            icon={Copy}
            size="xs"
            label={t('复制全部输出')}
            disabled={!all}
            onClick={() => void copyText(all, { done: t('已复制输出') })}
          />
        </span>
      </div>
      {dirty > 0 && (
        <p className="shrink-0 border-y bg-warning/8 px-3 py-1 text-footnote text-warning">
          {t('有 {n} 张表还有没保存的改动：导表读的是磁盘上的文件，这些改动没有带上。', { n: dirty })}
        </p>
      )}
      <div
        ref={stick.ref}
        onScroll={stick.onScroll}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-(--code-bg)"
      >
        <div className="flex flex-col gap-3 px-3 py-2.5 font-mono text-footnote leading-[1.7]">
          {steps.map((s, i) => {
            const bad = s.ended && (s.code !== 0 || !!s.killed || !!s.error)
            return (
              <div key={i}>
                <div className="flex items-start gap-2.5">
                  <span aria-hidden className="shrink-0 select-none text-accent-text">
                    $
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{s.line}</span>
                </div>
                {(s.out.length > 0 || s.ended) && (
                  <pre
                    className={cn(
                      'mt-1.5 ml-5 border-l pl-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
                      bad ? 'border-danger/40 text-danger/90' : 'border-line text-muted',
                    )}
                  >
                    {s.dropped > 0 && (
                      <span className="text-subtle">{t('…前面还有 {n} 行', { n: s.dropped }) + '\n'}</span>
                    )}
                    {s.out.join('\n')}
                    {s.ended && (
                      <span className={cn('block font-sans text-caption', bad ? 'text-danger' : 'text-subtle')}>
                        {s.error
                          ? t('启动失败：{err}', { err: s.error })
                          : s.killed === 'timeout'
                            ? t('超过 {n} 分钟，已停止', { n: script.timeoutMin })
                            : s.killed
                              ? t('已停止')
                              : t('退出码 {code}', { code: s.code ?? '-' })}
                      </span>
                    )}
                  </pre>
                )}
              </div>
            )
          })}
          {phase === 'running' && !steps.length && <p className="font-sans text-subtle">{t('正在启动…')}</p>}
          {error && <p className="font-sans text-body text-danger">{error}</p>}
        </div>
      </div>
    </div>
  )
}
