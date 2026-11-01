import type { HTMLAttributes } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

const tones = {
  neutral: 'bg-sel/70 text-muted',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  // 失败计数这类：和 StatusPill 的 err 同一个底色，但字号、高度跟 Badge 走，放在行里不撑高
  danger: 'bg-danger/10 text-danger',
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-(--c-badge-radius) px-2 py-px text-xs whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}

/** 状态小圆点 + 文字 */
export function StatusDot({
  tone,
  label,
  compact,
}: {
  tone: 'success' | 'warning' | 'muted'
  label?: string
  /** 和紧凑列表行搭配时用小一号字，行尾不抢标题 */
  compact?: boolean
}) {
  const color = {
    success: 'bg-success text-success',
    warning: 'bg-warning text-warning',
    muted: 'bg-subtle text-subtle',
  }[tone]
  return (
    <span className={cn('inline-flex items-center gap-1.5', compact ? 'text-caption' : 'text-xs', color.split(' ')[1])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', color.split(' ')[0])} />
      {label}
    </span>
  )
}

/**
 * 「这一轮做完了、你还没看过」的小圆点：侧栏的对话行、父对话里的子对话行画同一个。
 * 要不要画由 shared/task.ts 的 taskDoneDot / childDoneDot 判，这里只管样式和读屏文案
 */
export function UnreadDot({ className }: { className?: string }) {
  const label = t('对话已完成，还没查看')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('h-2 w-2 shrink-0 rounded-full bg-accent', className)}
    />
  )
}
