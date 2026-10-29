import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 插在一行文字里的引用：前面缩略图或图标，中间名字，后面一小段状态（引用路径 / 已上传 / Skill / 命令）。
 * 高度固定 1.5rem、上下各留 0.125rem，所在的行把行高设成 1.75rem（`leading-7`）时和文字居中齐平
 */
export function InlineChip({
  icon,
  label,
  status,
  mono,
  onClick,
  title,
  className,
}: {
  icon?: ReactNode
  label: ReactNode
  status?: ReactNode
  /** 路径、命令用等宽字 */
  mono?: boolean
  onClick?: () => void
  title?: string
  className?: string
}) {
  const cls = cn(
    'mx-0.5 my-0.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-sel/70 px-1.5 align-top text-[0.75rem] leading-none whitespace-nowrap',
    onClick && 'cursor-pointer transition-colors hover:bg-sel',
    className,
  )
  const body = (
    <>
      {icon && <span className="flex shrink-0 items-center text-subtle">{icon}</span>}
      <span className={cn('min-w-0 truncate', mono && 'font-mono text-[0.75rem]')}>{label}</span>
      {status && <span className="shrink-0 text-[0.6875rem] text-subtle">{status}</span>}
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={cls}>
      {body}
    </button>
  ) : (
    <span title={title} className={cls}>
      {body}
    </span>
  )
}
