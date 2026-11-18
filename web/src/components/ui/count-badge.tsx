import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** 默认最多显示到 999，再多写「999+」：四位数的角标会把圆撑成长条，盖住卡片标题 */
export const COUNT_BADGE_MAX = 999

/** 角标上的文字：0 和负数不显示（返回空串），超过上限写「上限+」 */
export const countBadgeText = (n: number, max = COUNT_BADGE_MAX) =>
  !Number.isFinite(n) || n <= 0 ? '' : n > max ? `${max}+` : String(Math.floor(n))

/**
 * 圆底数字角标（像手机消息提示）：贴在卡片、按钮右上角写「发生了几次」。
 * 没发生（0）就不画，免得一排卡片上全是 0；超过上限写「999+」。
 * 大小、底色在设置 → 组件 → 流程图画布里调（--c-countBadge-*），文字颜色跟着底色取反色。
 * corner 时自己定位到父元素右上角、压在边线上，父元素要 relative
 */
export function CountBadge({
  count,
  max = COUNT_BADGE_MAX,
  corner,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & { count: number; max?: number; corner?: boolean }) {
  const text = countBadgeText(count, max)
  if (!text) return null
  return (
    <span
      data-count-badge=""
      className={cn(
        'inline-flex h-(--c-countBadge-size) min-w-(--c-countBadge-size) shrink-0 items-center justify-center rounded-full px-[0.3em] text-[length:calc(var(--c-countBadge-size)*0.6)] leading-none font-semibold text-(--on-danger) tabular-nums',
        'bg-(--c-countBadge-bg) ring-2 ring-(--c-countBadge-ring)',
        corner &&
          'pointer-events-none absolute -top-[calc(var(--c-countBadge-size)/2)] -right-[calc(var(--c-countBadge-size)/2.5)] z-10',
        className,
      )}
      {...rest}
    >
      {text}
    </span>
  )
}
