import { forwardRef, type ButtonHTMLAttributes } from 'react'
import * as D from '@radix-ui/react-dialog'
import { X, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/**
 * 弹窗遮罩：Modal、Sheet 和各处手写的 D.Overlay 用同一个，透明度只在 index.css 的 --scrim 定义。
 * z-40 压在页面上、弹窗本体是 z-50
 */
export const MODAL_OVERLAY = 'fixed inset-0 z-40 bg-scrim anim-scrim'

/**
 * 弹窗宽度档：sm 确认类小表单，md 常规表单（默认），lg 宽表单（原来的 wide），xl 带侧栏的编辑器，full 几乎铺满（查看器）；
 * fit 是跟着内容高的查看器：内容少时矮，多了才拉高，最高到 full 的四分之三（一次编辑的差异通常就几行，铺满太空）
 */
const SIZES = {
  sm: 'max-w-[420px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[760px]',
  xl: 'max-w-[1100px]',
  // 照 Claude Code 网页版的方案弹窗：四周各留 30px 露出背后的页面，不设最大宽度，大屏上也铺满
  full: 'h-[calc(100dvh-3.75rem)] max-h-none w-[calc(100%-3.75rem)] max-w-none',
  fit: 'max-h-[calc((100dvh-3.75rem)*0.75)] w-[calc(100%-3.75rem)] max-w-none',
} as const

export type ModalSize = keyof typeof SIZES

/**
 * 弹窗外壳（照 Claude Code 网页版的方案弹窗）：圆角 8、一圈前景色 7% 的细线、深色下比页面亮一档的窗口色。
 * Modal 和各处手写 D.Content 的弹窗（确认框）都用这一份，改外壳只改这里和 index.css 的 --c-modal-*
 */
export const MODAL_SURFACE =
  'flex flex-col overflow-hidden rounded-(--c-modal-radius) border-(length:--c-modal-border) border-(color:--modal-edge) bg-(--c-modal-bg) shadow-pop'

/** 标题栏右侧管窗口的按钮：24px 见方、16px 图标、前景灰，悬停出浅底（方案弹窗右上角那一排） */
export const MODAL_BTN =
  'grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40 aria-pressed:text-fg data-[state=open]:bg-active data-[state=open]:text-fg [&>svg]:h-4 [&>svg]:w-4'

/** 标题栏的外框（ModalHeader 用的同一份）：标题栏里内容太特殊、只能自己排的弹窗直接套这个 class */
export const MODAL_HEADER =
  'flex h-[2.0625rem] shrink-0 items-center gap-2 border-b border-(color:--modal-edge) pr-1.5 pl-2.5'

/** 标题栏标题文字：13px、中等字重、前景色 */
export const MODAL_TITLE = 'min-w-0 shrink truncate text-[0.8125rem] font-medium text-fg'

/** 已经用 IconButton（size="sm"）写的标题栏按钮叠这个 class，就和 ModalButton 一样大 */
export const MODAL_ICON_BTN = 'h-6 w-6 rounded-md text-muted hover:text-fg'

/** 标题栏上的一个图标按钮：读屏名和悬停提示同一句 label */
export const ModalButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { icon: LucideIcon; label: string }
>(({ icon: Icon, label, className, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} aria-label={label} title={label} className={cn(MODAL_BTN, className)} {...props}>
    <Icon />
  </button>
))
ModalButton.displayName = 'ModalButton'

/** 标题栏最右边的关闭：比其他按钮的 X 略大一号（方案弹窗的 ✕ 是 18px） */
export function ModalClose({ label, onClick }: { label?: string; onClick?: () => void }) {
  return (
    <D.Close asChild>
      <ModalButton
        icon={X}
        label={label ?? t('关闭')}
        className="[&>svg]:h-[1.125rem] [&>svg]:w-[1.125rem]"
        onClick={onClick}
      />
    </D.Close>
  )
}

/**
 * 弹窗标题栏（照 Claude Code 网页版的方案弹窗）：32px 高、底下一道细线；左边 14px 灰图标 + 13px 标题 + 灰色小字说明，
 * 右边一排 24px 的图标按钮，最后是关闭。所有弹窗的标题栏都用它，别再各自写 h-14 / py-3 的头
 */
export function ModalHeader({
  icon: Icon,
  iconClass,
  title,
  titleClass,
  titleAttr,
  meta,
  children,
  aside,
  actions,
  close = true,
  className,
}: {
  icon?: LucideIcon
  /** 图标改色（排查报错用红色） */
  iconClass?: string
  /** 画进 D.Title；传 null 时调用方在 children 里自己放 D.Title */
  title: React.ReactNode
  /** 标题改字体（文件路径、命令用等宽） */
  titleClass?: string
  /** 标题被截断时的悬停全文 */
  titleAttr?: string
  /** 标题后面的灰色小字（时间、来源、名字） */
  meta?: React.ReactNode
  /** 紧跟在标题、说明后面的内容（标签…） */
  children?: React.ReactNode
  /** 靠右、排在图标按钮前面的内容（状态胶囊、嵌入对话自己的工具） */
  aside?: React.ReactNode
  /** 右侧图标按钮（ModalButton），排在关闭前面 */
  actions?: React.ReactNode
  /** 不画关闭按钮：false；要自己处理关闭（最小化到浮条）时传 ModalClose 之外的按钮进 actions */
  close?: boolean
  className?: string
}) {
  return (
    <header className={cn(MODAL_HEADER, className)}>
      {Icon && <Icon className={cn('h-3.5 w-3.5 shrink-0 text-subtle', iconClass)} />}
      {title !== null && (
        <D.Title title={titleAttr} className={cn(MODAL_TITLE, titleClass)}>
          {title}
        </D.Title>
      )}
      {meta && <span className="min-w-0 shrink-[2] truncate text-[0.75rem] text-subtle">{meta}</span>}
      {children}
      <span className="flex-1" />
      {aside}
      {(actions || close) && (
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          {close && <ModalClose />}
        </div>
      )}
    </header>
  )
}
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
            'fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-3.75rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 anim-dialog focus:outline-none',
            MODAL_SURFACE,
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
              <ModalHeader title={title} />
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
              {footer && (
                <div className="flex items-center gap-2 border-t border-(color:--modal-edge) px-5 py-3">{footer}</div>
              )}
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
