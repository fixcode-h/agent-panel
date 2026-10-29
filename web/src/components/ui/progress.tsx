import { cn } from '@/lib/utils'

const tones = {
  accent: 'bg-accent',
  run: 'bg-run',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

/**
 * 进度条：凹下去的轨道（深色下压暗，见 index.css 的 sunken）+ 实心的已完成段，圆头、不描边。
 * value 按 max 折成百分比，超出 0–max 的值夹回范围内，不会画出轨道
 */
export function Progress({
  value,
  max = 100,
  tone = 'accent',
  size = 'sm',
  label,
  className,
}: {
  value: number
  max?: number
  tone?: keyof typeof tones
  /** xs 2px（行里、卡片底部），sm 6px（独立一行） */
  size?: 'xs' | 'sm'
  /** 读屏名，如「上传进度」 */
  label: string
  className?: string
}) {
  const pct = max > 0 && Number.isFinite(value) ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('sunken w-full overflow-hidden rounded-full', size === 'xs' ? 'h-0.5' : 'h-1.5', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', tones[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export const PROGRESS_TONES = Object.keys(tones) as (keyof typeof tones)[]
