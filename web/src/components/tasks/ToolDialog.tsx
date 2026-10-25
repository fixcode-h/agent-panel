import { useEffect, useRef } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Copy, Loader2, Terminal, TerminalSquare, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { fmtDuration } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { Button } from '@/components/ui/button'

/** 窗口最外面那层：和差异窗口、文件窗口一样的大小和动画，内容区铺满屏幕 */
const shell =
  'fixed top-1/2 left-1/2 z-50 flex h-[min(900px,calc(100dvh-2rem))] w-[min(1440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none'

/**
 * 命令行窗口的高度跟着输出走：命令短、输出只有几行时不用撑满一屏白片，
 * 输出多了才长到上限、在窗口里滚动。宽度和别的窗口一致
 */
const termShell =
  'fixed top-1/2 left-1/2 z-50 flex max-h-[min(900px,calc(100dvh-2rem))] min-h-[min(360px,calc(100dvh-2rem))] w-[min(1440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none'

/** 复制成功都说一句复制了什么：命令和输出共用一个按钮时，光说「已复制」分不清 */
const copy = (text: string, done: string) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(done))
    .catch(() => {})

/** 还在跑时光标一直闪：比只有一个转圈更能看出输出还在往下走 */
function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[0.95em] w-[0.45em] translate-y-[0.12em] animate-pulse bg-accent/75 align-baseline"
    />
  )
}

/**
 * 工具调用的输出（搜索、网页、MCP 等）：窗口里看完整内容，太长的不会把对话挤满。
 * 命令有自己的窗口（CommandDialog），这里只看说明和输出
 */
export function OutputDialog({
  title,
  detail,
  input,
  output,
  failed,
  running,
  open,
  onOpenChange,
}: {
  title: string
  /** 命令或搜索词这一类短说明 */
  detail?: string
  input?: string
  output?: string
  failed?: boolean
  running?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const text = output ?? ''
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content aria-describedby={undefined} className={shell}>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <D.Title className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={title}>
              {title}
            </D.Title>
            {detail && (
              <span className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted" title={detail}>
                {detail}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制')}
              title={t('复制')}
              disabled={!text}
              onClick={() => copy(text, t('已复制'))}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-(--code-bg)">
            {input && input.trim() && input.trim() !== detail?.trim() && (
              <div className="border-b px-4 py-3">
                <div className="mb-1 font-sans text-[0.6875rem] font-medium tracking-wider text-subtle">IN</div>
                <pre className="font-mono text-[0.78125rem] leading-[1.6] whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">
                  {input}
                </pre>
              </div>
            )}
            <div className="px-4 py-3">
              <div className="mb-1 font-sans text-[0.6875rem] font-medium tracking-wider text-subtle">OUT</div>
              {text.trim() ? (
                <pre
                  className={cn(
                    'font-mono text-[0.78125rem] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]',
                    failed ? 'text-danger' : 'text-fg/90',
                  )}
                >
                  {text}
                </pre>
              ) : running ? (
                <p className="flex items-center gap-2 text-[0.8125rem] text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('还在执行…')}
                </p>
              ) : (
                <p className="text-[0.8125rem] text-subtle">{t('没有输出')}</p>
              )}
            </div>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/**
 * 跑命令的工具行点开：像终端一样看这条命令和它的输出。
 * 输出在跑的时候跟着更新，滚动条停在底部时自动跟随
 */
export function CommandDialog({
  command,
  output,
  failed,
  running,
  ms,
  startedAt,
  open,
  onOpenChange,
}: {
  command: string
  output?: string
  failed?: boolean
  running?: boolean
  /** 跑完用了多久（毫秒） */
  ms?: number
  /** 开始的时间：还在跑时每秒往上加，不用等结果回来才看得到用了多久 */
  startedAt?: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const text = output?.replace(/\s+$/, '') ?? ''
  const hasOutput = !!text.trim()
  const now = useNow(!!running && startedAt !== undefined)
  const elapsed = running ? (startedAt === undefined ? undefined : now - startedAt) : ms
  const lines = hasOutput ? text.split('\n').length : 0
  // 输出变了（命令还在跑）：停在底部时跟着滚
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [output])

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content aria-describedby={undefined} className={termShell}>
          {/* 标题就是命令本身（悬停看全文），右边是状态和用时，不再是空的「命令」两个字 */}
          <header className="flex h-14 shrink-0 items-center gap-2.5 border-b bg-card px-4">
            <Terminal className="h-4 w-4 shrink-0 text-subtle" />
            <D.Title className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={command}>
              <span aria-hidden className="mr-1.5 select-none text-subtle">
                $
              </span>
              {command}
            </D.Title>
            <span
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-sans text-[0.6875rem]',
                failed
                  ? 'border-danger/30 bg-danger/10 text-danger'
                  : running
                    ? 'border-accent/35 bg-accent-soft text-accent'
                    : 'border-line bg-field text-subtle',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  failed ? 'bg-danger' : running ? 'animate-pulse bg-accent' : 'bg-success',
                )}
              />
              {failed ? t('失败') : running ? t('执行中') : t('完成')}
              {elapsed !== undefined && <span className="tabular-nums opacity-80">{fmtDuration(elapsed)}</span>}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制命令')}
              title={t('复制命令')}
              onClick={() => copy(command, t('已复制命令'))}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制全部输出')}
              title={t('复制全部输出')}
              disabled={!hasOutput}
              onClick={() => copy(text, t('已复制输出'))}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div
            ref={box}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
            className="min-h-0 flex-1 overflow-auto overscroll-contain bg-(--code-bg)"
          >
            <div className="px-5 py-4 font-mono text-[0.78125rem] leading-[1.7]">
              <div className="flex items-start gap-2.5">
                <span aria-hidden className="shrink-0 select-none text-accent">
                  $
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{command}</span>
              </div>
              {hasOutput && (
                <div className="mt-2.5 flex gap-2.5">
                  {/* 占住 $ 那一列的宽度，左侧竖线把命令和输出分成两层 */}
                  <span aria-hidden className="w-2.5 shrink-0" />
                  <pre
                    className={cn(
                      'min-w-0 flex-1 border-l pl-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
                      failed ? 'border-danger/40 text-danger/90' : 'border-line text-muted',
                    )}
                  >
                    {text}
                    {running && <Caret />}
                  </pre>
                </div>
              )}
              {!hasOutput &&
                (running ? (
                  <div className="mt-2.5 flex gap-2.5">
                    <span aria-hidden className="w-2.5 shrink-0" />
                    <p className="flex min-w-0 flex-1 items-center gap-2 border-l border-line pl-3 text-subtle">
                      <Caret />
                      {t('正在执行，等待输出…')}
                    </p>
                  </div>
                ) : (
                  /* 空状态也说清楚为什么空、下一步看什么，不留一行灰字 */
                  <div className="mt-5 flex items-start gap-3 rounded-xl border border-dashed border-line-strong/70 bg-card/40 px-4 py-4 font-sans">
                    <TerminalSquare className={cn('mt-0.5 h-4 w-4 shrink-0', failed ? 'text-danger' : 'text-subtle')} />
                    <div className="min-w-0">
                      <p className={cn('text-[0.8125rem] font-medium', failed ? 'text-danger' : 'text-muted')}>
                        {failed ? t('执行失败，没有输出') : t('这条命令没有输出')}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-subtle">
                        {failed
                          ? t('这次调用没有标准输出或错误输出，关掉窗口展开这次调用可以看到返回的错误。')
                          : t('命令正常结束，没有标准输出或错误输出。')}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </div>
          {/* 底部常驻一条状态：长输出滚到哪都看得出还在跑 */}
          {running && (
            <div className="flex h-9 shrink-0 items-center gap-2 border-t bg-card/70 px-4 font-sans text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
              {t('正在执行…')}
              {lines > 0 && (
                <span className="ml-auto font-mono text-[0.6875rem] text-subtle tabular-nums">
                  {t('输出 {n} 行', { n: lines })}
                </span>
              )}
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
