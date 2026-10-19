import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Loader2 } from 'lucide-react'
import { Button } from './button'
import { t } from '@shared/i18n'

/** 确认对话框，用于删除等不可撤销的操作 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = t('删除'),
  onConfirm,
  onOpenChange,
  blocked,
  extra,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmText?: string
  /** 返回 Promise 时，执行期间按钮显示进行中，不能重复点击 */
  onConfirm: () => unknown
  onOpenChange: (open: boolean) => void
  /** 现在不能执行的原因（例如还在被使用）；有值时只显示原因，不提供确认按钮 */
  blocked?: string
  /** 说明下面的额外内容，例如「以后不再提醒」 */
  extra?: React.ReactNode
}) {
  const [pending, setPending] = useState(false)
  const confirm = async () => {
    if (pending) return
    setPending(true)
    try {
      await onConfirm()
    } finally {
      setPending(false)
    }
  }
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-card p-6 shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none">
          <D.Title className="text-[0.9375rem] font-semibold">{title}</D.Title>
          {description && (
            <D.Description className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">{description}</D.Description>
          )}
          {extra && <div className="mt-3">{extra}</div>}
          {blocked && (
            <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[0.8125rem] leading-relaxed text-warning">
              {blocked}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {blocked ? t('知道了') : t('取消')}
            </Button>
            {!blocked && (
              <Button variant="danger" disabled={pending} onClick={confirm}>
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {confirmText}
              </Button>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
