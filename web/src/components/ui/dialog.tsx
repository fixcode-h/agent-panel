import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = D.Root

function Overlay() {
  return (
    <D.Overlay className="fixed inset-0 z-40 bg-[oklch(0.1_0.01_286/0.55)] backdrop-blur-sm animate-[fade-in_180ms_ease-out]" />
  )
}

/** 右侧浮出的抽屉，适合较长的编辑表单 */
export function SheetContent({
  title,
  description,
  icon,
  children,
  footer,
}: {
  title: string
  description?: string
  icon?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content className="fixed inset-y-2 right-2 z-50 flex w-[calc(100%-1rem)] max-w-[560px] flex-col overflow-hidden rounded-2xl border border-border-strong bg-elevated shadow-2xl animate-[sheet-in_260ms_cubic-bezier(0.2,0.8,0.2,1)] focus:outline-none">
        <div className="flex items-center gap-3 border-b px-6 py-4">
          {icon}
          <div className="min-w-0 flex-1">
            <D.Title className="text-[15px] font-semibold">{title}</D.Title>
            {description && <D.Description className="mt-0.5 truncate text-xs text-muted">{description}</D.Description>}
          </div>
          <D.Close className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <X className="h-4 w-4" />
          </D.Close>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t bg-surface-2/50 px-6 py-3.5">{footer}</div>}
      </D.Content>
    </D.Portal>
  )
}

/** 居中的小对话框，用于确认操作 */
export function DialogContent({
  title,
  description,
  icon,
  footer,
}: {
  title: string
  description?: React.ReactNode
  icon?: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2',
          'rounded-2xl border border-border-strong bg-elevated p-6 shadow-2xl animate-[pop-in_180ms_ease-out] focus:outline-none',
        )}
      >
        {icon && <div className="mb-4">{icon}</div>}
        <D.Title className="text-[15px] font-semibold">{title}</D.Title>
        {description && <D.Description className="mt-1.5 text-[13px] leading-relaxed text-muted">{description}</D.Description>}
        <div className="mt-6 flex justify-end gap-2">{footer}</div>
      </D.Content>
    </D.Portal>
  )
}
