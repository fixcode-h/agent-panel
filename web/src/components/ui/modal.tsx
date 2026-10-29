import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/**
 * 弹窗遮罩：Modal、Sheet 和各处手写的 D.Overlay 用同一个，透明度只在 index.css 的 --scrim 定义。
 * z-40 压在页面上、弹窗本体是 z-50
 */
export const MODAL_OVERLAY = 'fixed inset-0 z-40 bg-scrim animate-[fade-in_150ms_ease-out]'

/** 弹窗宽度档：sm 确认类小表单，md 常规表单（默认），lg 宽表单（原来的 wide），xl 带侧栏的编辑器，full 几乎铺满（查看器） */
const SIZES = {
  sm: 'max-w-[420px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[760px]',
  xl: 'max-w-[1100px]',
  full: 'h-[calc(100dvh-2rem)] max-w-[1400px]',
} as const

export type ModalSize = keyof typeof SIZES
/** 给样式表展示用（设置 → 组件） */
export const MODAL_SIZES = Object.keys(SIZES) as ModalSize[]

/** 表单弹窗：标题、内容、底部操作；改到一半点到外面不关闭，免得白填 */
export function Modal({
  open,
  onOpenChange,
  title,
  children,
  footer,
  wide,
  size,
  bare,
  closeOnOutside,
  stacked,
  onOpenAutoFocus,
  onEscapeKeyDown,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * bare 时不画出来，只给读屏当弹窗名。bare 且传 null：调用方在自己画的标题栏里放 D.Title
   * （标题里带路径、状态这类富内容时），免得同一个标题读两遍
   */
  title: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  /** 旧写法，等于 size="lg"；同时给了 size 时以 size 为准 */
  wide?: boolean
  size?: ModalSize
  /** 只要外壳（遮罩、居中、圆角卡片、Esc 关闭）：标题栏、内容留白、底栏都由调用方自己画（查看器、预览） */
  bare?: boolean
  /** 点到外面就关：只看不填的弹窗（预览、详情）用；表单默认不关 */
  closeOnOutside?: boolean
  /** 从另一个弹窗里打开、要整个压在它上面（文件预览里点开的差异）：遮罩和本体各抬高一层 */
  stacked?: boolean
  /** 打开时的默认焦点自己指定（preventDefault 后聚焦默认按钮）；不传时 Radix 聚焦第一个可聚焦元素 */
  onOpenAutoFocus?: (e: Event) => void
  /** Esc 先给调用方：弹窗里还有一层自己的编辑态（新建文件夹的输入框）时 preventDefault 只退出那一层，不关弹窗 */
  onEscapeKeyDown?: (e: KeyboardEvent) => void
  /** 加在弹窗本体上（固定高度、换底色等） */
  className?: string
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={cn(MODAL_OVERLAY, stacked && 'z-[60]')} />
        <D.Content
          aria-describedby={undefined}
          onInteractOutside={closeOnOutside ? undefined : (e) => e.preventDefault()}
          onOpenAutoFocus={onOpenAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none',
            SIZES[size ?? (wide ? 'lg' : 'md')],
            stacked && 'z-[70]',
            className,
          )}
        >
          {bare ? (
            <>
              {title !== null && <D.Title className="sr-only">{title}</D.Title>}
              {children}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b px-5 py-3.5">
                <D.Title className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold">{title}</D.Title>
                <D.Close
                  aria-label={t('关闭')}
                  className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
                >
                  <X className="h-4 w-4" />
                </D.Close>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
              {footer && <div className="flex items-center gap-2 border-t px-5 py-3">{footer}</div>}
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
