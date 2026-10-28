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
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center rounded-lg font-medium transition-[background-color,opacity,color] select-none',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

/** 给样式表展示用：按钮有哪些变体、尺寸（设置 → 组件） */
export const BUTTON_VARIANTS = Object.keys(variants) as (keyof typeof variants)[]
export const BUTTON_SIZES = Object.keys(sizes) as (keyof typeof sizes)[]
