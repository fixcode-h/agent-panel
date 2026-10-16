import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const tones = {
  neutral: 'bg-card text-muted border border-line',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-px text-xs whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}

/** 状态小圆点 + 文字 */
export function StatusDot({ tone, label }: { tone: 'success' | 'warning' | 'muted'; label?: string }) {
  const color = {
    success: 'bg-success text-success',
    warning: 'bg-warning text-warning',
    muted: 'bg-subtle text-subtle',
  }[tone]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', color.split(' ')[1])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', color.split(' ')[0])} />
      {label}
    </span>
  )
}
