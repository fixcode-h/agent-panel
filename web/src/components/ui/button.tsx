import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const variants = {
  primary: 'bg-accent text-white hover:brightness-110',
  secondary: 'bg-card text-fg border border-line-strong hover:bg-sel',
  ghost: 'text-muted hover:text-fg hover:bg-sel',
  danger: 'bg-danger text-white hover:brightness-110',
  'danger-outline': 'bg-card text-danger border border-line-strong hover:bg-danger/10',
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
        'inline-flex shrink-0 cursor-pointer items-center rounded-lg font-medium transition-colors select-none',
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
