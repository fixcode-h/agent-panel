import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 只有图标的小按钮（行尾的更多、关闭、复制、删除…）：不带底色，悬停才出浅底（设计稿 `.ib`）。
 * 读屏名和悬停提示是同一句 label，调用处不用再各写一遍 aria-label / title。
 * 尺寸：sm 28px（工具条），xs 24px（列表行），2xs 20px（行内、页签里）；图标跟着尺寸缩放
 */
const sizes = {
  sm: { box: 'h-7 w-7 rounded-(--c-iconButton-radius)', icon: 'h-4 w-4' },
  xs: { box: 'h-6 w-6 rounded-(--c-iconButton-radius)', icon: 'h-3.5 w-3.5' },
  '2xs': { box: 'h-5 w-5 rounded-sm', icon: 'h-3 w-3' },
}
const tones = {
  default: 'text-subtle hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg',
  danger:
    'text-subtle hover:bg-danger/10 hover:text-danger data-[state=open]:bg-danger/10 data-[state=open]:text-danger',
  // 页签条右端、输入框工具条这类一排图标（设计稿 `.ib`）：悬停也不出底，只把图标提到前景色；
  // 打开着（展开、按下、菜单开着）同样是前景色，靠颜色而不是底色表示「开着」
  bare: 'text-muted hover:text-fg aria-expanded:text-fg aria-pressed:text-fg data-[state=open]:text-fg',
}

export type IconButtonSize = keyof typeof sizes

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** lucide 图标组件，尺寸由 size 决定；要自己画（转圈、彩色头像）时传 children */
  icon?: LucideIcon
  /** 读屏名 + 悬停提示 */
  label: string
  size?: IconButtonSize
  tone?: keyof typeof tones
  /**
   * hover：平时隐藏，所在行悬停或按钮获得焦点时才出现（行尾操作）。行要带 Tailwind 的 `group` 类；
   * 菜单打开期间（data-state=open）保持可见
   */
  reveal?: 'hover'
  /** 图标线宽，默认跟着 lucide（2） */
  strokeWidth?: number
  children?: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon: Icon,
      label,
      size = 'xs',
      tone = 'default',
      reveal,
      strokeWidth,
      className,
      type = 'button',
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        // icon-btn / icon-btn-<tone>：给配色覆盖用的钩子（index.css 里「Claude Code」配色的悬停、选中底色）
        'icon-btn grid shrink-0 cursor-pointer place-items-center press outline-none',
        `icon-btn-${tone}`,
        'focus-visible:ring-2 focus-visible:ring-focus-soft disabled:pointer-events-none disabled:opacity-40',
        sizes[size].box,
        tones[tone],
        reveal === 'hover' &&
          'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
        className,
      )}
      {...props}
    >
      {children ?? (Icon && <Icon className={sizes[size].icon} strokeWidth={strokeWidth} />)}
    </button>
  ),
)
IconButton.displayName = 'IconButton'

export const ICON_BUTTON_SIZES = Object.keys(sizes) as IconButtonSize[]

/**
 * 图标开关（只读、自动滚动、显示空白符…）：和 IconButton 同一个外形，开着时图标换成强调色、不加底色
 * （设计稿「切换」一栏：图标开关不带底色，开着换成强调色）。状态用 aria-pressed 告诉读屏
 */
export const ToggleIconButton = forwardRef<
  HTMLButtonElement,
  Omit<IconButtonProps, 'onClick'> & {
    pressed: boolean
    onPressedChange: (pressed: boolean) => void
  }
>(({ pressed, onPressedChange, className, ...props }, ref) => (
  <IconButton
    ref={ref}
    aria-pressed={pressed}
    onClick={() => onPressedChange(!pressed)}
    className={cn(pressed && 'text-accent-text hover:text-accent-text', className)}
    {...props}
  />
))
ToggleIconButton.displayName = 'ToggleIconButton'
