import * as D from '@radix-ui/react-dialog'
import { Button } from './button'

/** 确认对话框，用于删除等不可撤销的操作 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '删除',
  onConfirm,
  onOpenChange,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmText?: string
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-card p-6 shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none">
          <D.Title className="text-[15px] font-semibold">{title}</D.Title>
          {description && (
            <D.Description className="mt-1.5 text-[13px] leading-relaxed text-muted">{description}</D.Description>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={onConfirm}>
              {confirmText}
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
