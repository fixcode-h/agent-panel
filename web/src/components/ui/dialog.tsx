import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Loader2 } from 'lucide-react'
import { Button } from './button'
import { MODAL_OVERLAY, MODAL_SURFACE } from './modal'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/**
 * 弹窗里内容滚动区的类：左右和顶部按常规留白，底部多留一截（48px，pb-12）。
 * 分页设置的滚动区下面紧贴「取消 / 确认」操作栏，不留白时最后一块看起来是压在栏上的；
 * 所有分页共用这一份，改间距只改这里。
 */
export const dialogScrollClass = 'flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-6 pb-12'

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
        <D.Overlay className={MODAL_OVERLAY} />
        {/* 外壳和所有弹窗同一份（MODAL_SURFACE）：圆角、细线、窗口底色 */}
        <D.Content
          className={cn(
            MODAL_SURFACE,
            'fixed top-1/2 left-1/2 z-50 block w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 p-6 anim-dialog focus:outline-none',
          )}
        >
          <D.Title className="text-heading font-semibold">{title}</D.Title>
          {description && (
            <D.Description className="mt-1.5 text-body leading-relaxed text-muted">{description}</D.Description>
          )}
          {extra && <div className="mt-3">{extra}</div>}
          {blocked && (
            <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-body leading-relaxed text-warning">{blocked}</p>
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
