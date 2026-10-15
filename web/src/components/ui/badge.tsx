import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const tones = {
  neutral: 'bg-surface-2 text-muted border',
  accent: 'bg-accent-soft text-accent border border-accent/25',
  success: 'bg-success/12 text-success border border-success/25',
  warning: 'bg-warning/12 text-warning border border-warning/25',
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}
