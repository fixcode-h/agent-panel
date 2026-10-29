import { cn } from '@/lib/utils'

/**
 * 上下文用量圆环：空心圆环 + 百分比，不写「上下文」三个字（读屏名里有）。
 * 超过 80% 换成警告色，提醒快要自动压缩了
 */
export function ContextRing({
  percent,
  label,
  className,
}: {
  /** 0–100 */
  percent: number
  /** 读屏名和悬停提示，如「上下文已用 23%」 */
  label: string
  className?: string
}) {
  const p = Math.max(0, Math.min(100, percent))
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <span role="img" aria-label={label} title={label} className={cn('inline-flex items-center gap-1.5', className)}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0 -rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="3" className="stroke-line-strong" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="3"
          strokeDasharray={`${(c * p) / 100} ${c}`}
          className={cn('transition-[stroke-dasharray] duration-300', p >= 80 ? 'stroke-warning' : 'stroke-muted')}
        />
      </svg>
      <span className="font-mono text-[0.6875rem] text-muted tabular-nums">{Math.round(p)}%</span>
    </span>
  )
}
