import { useEffect, useRef } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Copy, Loader2, Terminal, X } from 'lucide-react'
import { toast } from 'sonner'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 窗口最外面那层：和差异窗口、文件窗口一样的大小和动画，内容区铺满屏幕 */
const shell =
  'fixed top-1/2 left-1/2 z-50 flex h-[min(900px,calc(100dvh-2rem))] w-[min(1440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none'

const copy = (text: string) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(t('已复制')))
    .catch(() => {})

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
              onClick={() => copy(text)}
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
  open,
  onOpenChange,
}: {
  command: string
  output?: string
  failed?: boolean
  running?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // 输出变了（命令还在跑）：停在底部时跟着滚
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [output])

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content aria-describedby={undefined} className={shell}>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <Terminal className="h-4 w-4 shrink-0 text-subtle" />
            <D.Title className="min-w-0 flex-1 truncate font-sans text-[0.8125rem] font-medium">{t('命令')}</D.Title>
            {running && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />}
            {failed && <span className="shrink-0 font-sans text-xs text-danger">{t('失败')}</span>}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制命令')}
              title={t('复制命令')}
              onClick={() => copy(command)}
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
            className="min-h-0 flex-1 overflow-auto bg-(--code-bg) px-4 py-3 font-mono text-[0.78125rem] leading-[1.7]"
          >
            <div className="flex gap-2 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
              <span className="shrink-0 text-accent select-none">$</span>
              <span>{command}</span>
            </div>
            {output?.replace(/\s+$/, '') ? (
              <pre
                className={cn(
                  'mt-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
                  failed ? 'text-danger/90' : 'text-muted',
                )}
              >
                {output}
              </pre>
            ) : running ? (
              <p className="mt-3 text-subtle">{t('还在执行…')}</p>
            ) : (
              <p className="mt-3 text-subtle">{t('没有输出')}</p>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
