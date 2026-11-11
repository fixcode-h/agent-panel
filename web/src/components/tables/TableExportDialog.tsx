import { useEffect, useRef, useState } from 'react'
import { Copy, Square, Terminal } from 'lucide-react'
import { t } from '@shared/i18n'
import { exportName, type ExportEvent, type TableExport } from '@shared/table-export'
import { tablesApi } from '@/lib/tables-api'
import { copyText } from '@/lib/copy-text'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { useNow } from '@/lib/useNow'
import { fmtDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { StatusPill } from '@/components/ui/status-pill'

/** 每条命令最多留这么多行输出：导几千张表时输出很长，只看结尾，页面不卡 */
const KEEP_LINES = 3000

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

type Phase = 'running' | 'done' | 'failed' | 'stopped'

/**
 * 执行导表脚本的窗口：一打开就开始跑，像终端一样逐条显示要执行的命令（占位已换成真实路径）和它的输出。
 * 停止或关掉窗口都会停掉命令；一条失败后面的不再跑，失败原因原样显示
 */
export function TableExportDialog({
  projectId,
  index,
  script,
  paths,
  dirty,
  onClose,
}: {
  projectId: string
  /** 第几个导表脚本 */
  index: number
  script: TableExport
  /** 要导的表格 */
  paths: string[]
  /** 这些表里有几张还有没保存的改动（导表读的是磁盘上的文件） */
  dirty: number
  onClose: () => void
}) {
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
    // 窗口打开时跑一次；换脚本、换表是新开一个窗口
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stop = () => {
    abort.current?.abort()
    setPhase('stopped')
    setMs(Date.now() - startedAt)
  }
  const stick = useStickToBottom(steps.length)
  const all = steps.map((s) => `$ ${s.line}\n${s.out.join('\n')}`).join('\n\n')
  const tone = phase === 'running' ? 'run' : phase === 'done' ? 'ok' : phase === 'failed' ? 'err' : 'idle'
  const label = { running: t('执行中'), done: t('完成'), failed: t('失败'), stopped: t('已停止') }[phase]
  const elapsed = phase === 'running' ? now - startedAt : ms
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={null} size="term" bare>
      <ModalHeader
        icon={Terminal}
        title={exportName(script, index)}
        meta={paths.length === 1 ? paths[0] : t('{n} 张表', { n: paths.length })}
        aside={
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
        }
        actions={
          <>
            {phase === 'running' && <ModalButton icon={Square} label={t('停止')} onClick={stop} />}
            <ModalButton
              icon={Copy}
              label={t('复制全部输出')}
              disabled={!all}
              onClick={() => void copyText(all, { done: t('已复制输出') })}
            />
          </>
        }
      />
      {dirty > 0 && (
        <p className="shrink-0 border-b bg-warning/8 px-5 py-1.5 text-footnote text-warning">
          {t('有 {n} 张表还有没保存的改动：导表读的是磁盘上的文件，这些改动没有带上。', { n: dirty })}
        </p>
      )}
      <div
        ref={stick.ref}
        onScroll={stick.onScroll}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-(--code-bg)"
      >
        <div className="flex flex-col gap-4 px-5 py-4 font-mono text-footnote leading-[1.7]">
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
    </Modal>
  )
}
