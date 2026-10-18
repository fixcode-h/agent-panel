import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 表单弹窗：标题、内容、底部操作；改到一半点到外面不关闭，免得白填 */
export function Modal({
  open,
  onOpenChange,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none',
            wide ? 'max-w-[760px]' : 'max-w-[520px]',
          )}
        >
          <div className="flex items-center gap-2 border-b px-5 py-3.5">
            <D.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</D.Title>
            <D.Close
              aria-label={t('关闭')}
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
            >
              <X className="h-4 w-4" />
            </D.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center gap-2 border-t px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
