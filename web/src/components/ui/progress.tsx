import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const tones = {
  accent: 'bg-accent',
  run: 'bg-run',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

/**
 * 进度条：淡色轨道（--c-progress-track，前景色 14%，深浅色都看得见）+ 实心的已完成段，圆头、不描边。
 * value 按 max 折成百分比，超出 0–max 的值夹回范围内，不会画出轨道
 */
export function Progress({
  value,
  max = 100,
  tone = 'accent',
  size = 'sm',
  label,
  raw,
  indeterminate,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'role'> & {
  value: number
  max?: number
  tone?: keyof typeof tones
  /** xs 2px（行里、卡片底部），sm 6px（独立一行） */
  size?: 'xs' | 'sm'
  /** 读屏名，如「上传进度」 */
  label: string
  /** 读屏报原始的 value / max（「3/8 步」这种计数），不折成百分比；不传时和原来一样报 0–100 */
  raw?: boolean
  /** 不知道进度（还没拿到百分比）：画一小段闪动的条，读屏不报数值；不传时和原来一样 */
  indeterminate?: boolean
  className?: string
}) {
  const pct = max > 0 && Number.isFinite(value) ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={raw ? max : 100}
      aria-valuenow={indeterminate ? undefined : raw ? Math.min(max, Math.max(0, value)) : Math.round(pct)}
      className={cn(
        'w-full overflow-hidden bg-(--c-progress-track) rounded-(--c-progress-radius)',
        size === 'xs' ? 'h-0.5' : 'h-(--c-progress-height)',
        className,
      )}
      {...rest}
    >
      <div
        className={cn(
          'h-full rounded-(--c-progress-radius) transition-[width] duration-300',
          tones[tone],
          indeterminate && 'w-1/3 animate-pulse',
        )}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  )
}

export const PROGRESS_TONES = Object.keys(tones) as (keyof typeof tones)[]
