import type { ReactNode } from 'react'
import type { ChipKind } from '@shared/composer'
import { cn } from '@/lib/utils'
import { CHIP_TONE } from './chip-tone'

/**
 * 插在一行文字里的引用：前面缩略图或图标，中间名字，后面一小段状态（引用路径 / 已上传 / Skill / 命令）。
 * 高度固定 1.5rem、上下各留 0.125rem，所在的行把行高设成 1.75rem（`leading-7`）时和文字居中齐平。
 * 按 tone 着色（和输入框、消息里的卡片同一套 CHIP_TONE），在文字里一眼能看出是引用
 */
export function InlineChip({
  icon,
  tone = 'file',
  label,
  status,
  mono,
  onClick,
  title,
  className,
}: {
  icon?: ReactNode
  /** 按哪类卡片着色：图片、文件 / 路径、Skill / 命令、引用 */
  tone?: ChipKind
  label: ReactNode
  status?: ReactNode
  /** 路径、命令用等宽字 */
  mono?: boolean
  onClick?: () => void
  title?: string
  className?: string
}) {
  const c = CHIP_TONE[tone]
  const cls = cn(
    'mx-0.5 my-0.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded-(--c-chip-radius) px-1.5 align-top text-footnote leading-none whitespace-nowrap ring-(length:--c-chip-ring) ring-inset',
    c.box,
    onClick && cn('cursor-pointer transition-colors', c.hover),
    className,
  )
  const body = (
    <>
      {icon && <span className={cn('flex shrink-0 items-center', c.icon)}>{icon}</span>}
      <span className={cn('min-w-0 truncate', mono && 'font-mono text-footnote')}>{label}</span>
      {status && <span className={cn('shrink-0 text-caption', c.status)}>{status}</span>}
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
