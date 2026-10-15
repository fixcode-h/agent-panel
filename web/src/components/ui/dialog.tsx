import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = D.Root

function Overlay() {
  return <D.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] animate-[fade-in_150ms_ease-out]" />
}

/** 右侧滑出的抽屉，适合较长的编辑表单 */
export function SheetContent({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-surface shadow-2xl animate-[sheet-in_220ms_cubic-bezier(0.2,0.8,0.2,1)] focus:outline-none">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-5">
          <div>
            <D.Title className="text-base font-semibold">{title}</D.Title>
            {description && <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>}
          </div>
          <D.Close className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="h-4 w-4" />
          </D.Close>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t bg-surface-2/40 px-6 py-4">{footer}</div>}
      </D.Content>
    </D.Portal>
  )
}

/** 居中的小对话框，用于确认操作 */
export function DialogContent({
  title,
  description,
  footer,
}: {
  title: string
  description?: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-2xl border bg-surface p-6 shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none',
        )}
      >
        <D.Title className="text-base font-semibold">{title}</D.Title>
        {description && <D.Description className="mt-2 text-sm text-muted leading-relaxed">{description}</D.Description>}
        <div className="mt-6 flex justify-end gap-2">{footer}</div>
      </D.Content>
    </D.Portal>
  )
}
