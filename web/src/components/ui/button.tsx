import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const variants = {
  primary:
    'text-white bg-gradient-to-b from-accent to-[color-mix(in_oklch,var(--accent),black_14%)] ' +
    'shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_6px_20px_-6px_var(--accent)] hover:brightness-110',
  secondary: 'bg-surface text-fg border border-border-strong shadow-card hover:bg-surface-2',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:brightness-110 shadow-[0_6px_20px_-6px_var(--danger)]',
}
const sizes = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-9 px-4 text-[13px] gap-2 rounded-[10px]',
  icon: 'h-8 w-8 justify-center rounded-lg',
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
        'inline-flex items-center font-medium transition-all duration-150 select-none cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:opacity-50 disabled:pointer-events-none active:scale-[0.97]',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
