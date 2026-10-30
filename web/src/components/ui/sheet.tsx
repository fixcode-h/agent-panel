import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { MODAL_OVERLAY } from './modal'

/**
 * 抽屉：从左 / 右边滑出的一整列（计划详情、环境、对话信息）。桌面上和主区一样是一块浮起的面板（离边 8px、圆角），
 * 手机上贴边铺满；边界靠底色和浮层投影分，不描边。
 * modal=false 时不压遮罩、不锁页面，旁边还能继续操作（边看抽屉边改对话）；Esc 和点外面照样关
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  side = 'right',
  width = 'min(420px, 100%)',
  modal = true,
  actions,
  footer,
  bare,
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** bare 时不画出来，只给读屏当名字 */
  title: React.ReactNode
  side?: 'left' | 'right'
  /** CSS 宽度，默认最多 420px */
  width?: string
  modal?: boolean
  /** 标题栏右边、关闭按钮前的操作 */
  actions?: React.ReactNode
  footer?: React.ReactNode
  /** 只要外壳（定位、底色、滑入动画），里面全由调用方画 */
  bare?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <D.Portal>
        {modal && <D.Overlay className={MODAL_OVERLAY} />}
        <D.Content
          aria-describedby={undefined}
          style={{ width }}
          className={cn(
            'fixed inset-y-0 z-50 flex max-w-full flex-col overflow-hidden bg-(--c-sheet-bg) shadow-pop focus:outline-none md:inset-y-2 md:rounded-(--c-sheet-radius)',
            side === 'right'
              ? 'right-0 animate-[sheet-in-right_180ms_ease-out] md:right-2'
              : 'left-0 animate-[sheet-in-left_180ms_ease-out] md:left-2',
            className,
          )}
        >
          {bare ? (
            <>
              <D.Title className="sr-only">{title}</D.Title>
              {children}
            </>
          ) : (
            <>
              <div className="flex h-12 shrink-0 items-center gap-2 pr-2.5 pl-4">
                <D.Title className="min-w-0 flex-1 truncate text-[0.875rem] font-semibold">{title}</D.Title>
                {actions}
                <D.Close
                  aria-label={t('关闭')}
                  title={t('关闭')}
                  className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
                >
                  <X className="h-4 w-4" />
                </D.Close>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">{children}</div>
              {footer && <div className="flex shrink-0 items-center gap-2 bg-panel px-4 py-3">{footer}</div>}
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
