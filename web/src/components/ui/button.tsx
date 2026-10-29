import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * 按钮：扁平，不加阴影、渐变和描边（照 Claude 的界面，边界靠底色分）。
 * 主操作用配色的 primary；次要按钮浅灰底；ghost 只有文字和悬停底色
 */
const variants = {
  primary: 'bg-primary text-on-primary hover:opacity-90 active:opacity-80',
  secondary: 'bg-sel/70 text-fg hover:bg-sel',
  ghost: 'text-muted hover:text-fg hover:bg-sel',
  danger: 'bg-danger text-white hover:opacity-90 active:opacity-80',
  'danger-outline': 'bg-danger/10 text-danger hover:bg-danger/15',
  /** 文字链接样式的按钮（「打开这次执行」「重新生成」）：没有底色和高度，颜色看 tone，悬停加下划线 */
  link: '',
  /** 深色画布（设计页画板、预览台）上的按钮：画布不跟主题变，字和悬停底色用 --canvas-* 这组 */
  'on-canvas': 'text-canvas-fg hover:bg-canvas-hover hover:text-canvas-strong',
}
/** variant="link" 的颜色：强调色（默认）、灰字（次要的「清除」「重置」）、警告色（「仍要继续」这类）、危险色（失败记录） */
const linkTones = {
  accent: 'text-accent',
  muted: 'text-subtle hover:text-fg',
  warning: 'text-warning',
  /** 失败记录上的「失败 · AI 分析」：红字提示出了错，点进去看原因 */
  danger: 'text-danger',
}
const sizes = {
  sm: 'h-8 px-2.5 text-[0.8125rem] gap-1.5',
  md: 'h-9 px-3.5 text-[0.8125rem] gap-1.5',
  icon: 'h-9 w-9 justify-center',
  'icon-sm': 'h-7 w-7 justify-center',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
  /** 只对 variant="link" 起作用 */
  tone?: keyof typeof linkTones
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', tone = 'accent', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        // 链接按钮嵌在句子或说明里，字号、字重跟着上下文，不套按钮的高度和留白
        variant === 'link'
          ? 'inline-flex w-fit max-w-full cursor-pointer items-center gap-1 text-left underline-offset-2 transition-colors hover:underline'
          : 'inline-flex shrink-0 cursor-pointer items-center rounded-lg font-medium transition-[background-color,opacity,color] select-none',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        variant === 'link' ? linkTones[tone] : sizes[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

/** 给样式表展示用：按钮有哪些变体、尺寸（设置 → 组件） */
export const BUTTON_VARIANTS = (Object.keys(variants) as (keyof typeof variants)[]).filter(
  // on-canvas 只在深色画布上看得清，样式表里单独放在画布底上展示
  (v) => v !== 'on-canvas',
)
export const LINK_TONES = Object.keys(linkTones) as (keyof typeof linkTones)[]
export const BUTTON_SIZES = Object.keys(sizes) as (keyof typeof sizes)[]
