import type { HTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'

/**
 * 只读的统计卡片：图标块 + 名字 + 大号数字 + 一行小字说明，悬停看全文。
 * 总览页 Bug 视图、流程视图顶上那排数字都用它；样式和对话视图可点的分组卡片一样，只是不能点。
 * 其余 HTML 属性（data-*、aria-*）原样放到卡片上
 */
export function StatTile({
  icon: Icon,
  tile,
  label,
  value,
  note,
  short,
  dim,
  className,
  ...rest
}: {
  icon: LucideIcon
  /** 图标块的底色和图标色，例如 'bg-success/12 text-success' */
  tile: string
  label: string
  value: string
  /** 这个数是怎么来的：悬停时显示全文 */
  note: string
  /** 数字下面的一行小字放不下全文时写短的；不传就用 note */
  short?: string
  /** 没有样本：数字画淡 */
  dim?: boolean
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <Card className={cn('flex items-center gap-3 px-4 py-3', className)} title={note} {...rest}>
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', tile)}>
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs text-muted">{label}</span>
        <span className={cn('text-xl leading-tight font-semibold tabular-nums', dim ? 'text-subtle' : 'text-fg')}>
          {value}
        </span>
        <span className="truncate text-caption text-subtle">{short ?? note}</span>
      </span>
    </Card>
  )
}
