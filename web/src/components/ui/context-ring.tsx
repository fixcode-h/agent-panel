import { cn } from '@/lib/utils'

/**
 * 上下文用量圆环：空心圆环 + 百分比，不写「上下文」三个字（读屏名里有）。
 * 超过 80% 换成警告色，提醒快要自动压缩了
 */
export function ContextRing({
  percent,
  label,
  className,
  small,
}: {
  /** 0–100 */
  percent: number
  /** 读屏名和悬停提示，如「上下文已用 23%」 */
  label: string
  className?: string
  /** 小号（14px、细环）：放进输入框下面那一排小块里，和图标一样大；百分比跟着外面的字号 */
  small?: boolean
}) {
  const p = Math.max(0, Math.min(100, percent))
  // 设计稿：20px 的粗圆环，已用的一段是前景色（超过八成换警告色），没用的是浅线色
  const size = small ? 14 : 20
  const stroke = small ? 3 : 4.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-flex items-center', small ? 'gap-1.5' : 'gap-[7px]', className)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-line-strong" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={`${(c * p) / 100} ${c}`}
          className={cn('transition-[stroke-dasharray] duration-300', p >= 80 ? 'stroke-warning' : 'stroke-fg')}
        />
      </svg>
      {/* 百分比跟着外面的字色：放在无底按钮里时悬停一起变成前景色 */}
      <span className={cn('font-mono tabular-nums', !small && 'text-[0.71875rem]')}>{Math.round(p)}%</span>
    </span>
  )
}
