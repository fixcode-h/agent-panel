import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 分段单选：选项少、想一眼看全时用，比下拉框直观 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
  fill = false,
  tone = 'default',
  iconOnly = false,
}: {
  value: T
  onChange: (v: T) => void
  /** dot：选项上的提示点（例如那一页有要处理的事），文字放在悬停提示里 */
  /** icon：文字前的小图标（iconOnly 时只画它，label 进读屏名和悬停提示） */
  options: { id: T; label: string; disabled?: boolean; dot?: string; icon?: LucideIcon }[]
  label: string
  /** 撑满一行、换底色等版式调整；不传时和原来一样 */
  className?: string
  /** sm：页头工具条里用（比如计划页的「周 / 月 / 列表」），和 sm 按钮同高 */
  size?: 'sm' | 'md'
  /** 撑满一行、每段等宽（计划详情里的「重复」照设计稿就是这样）；不传时按文字宽度排 */
  fill?: boolean
  /** canvas：放在深色画布（设计页画板、预览台）上，轨道和选中块用 --canvas-* 这组色，不跟主题变 */
  tone?: 'default' | 'canvas'
  /** 只画图标的方块段（设计页的「桌面 / 平板 / 手机」）；不传时和原来一样写文字 */
  iconOnly?: boolean
}) {
  const canvas = tone === 'canvas'
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex max-w-full flex-wrap rounded-lg p-0.5',
        canvas ? 'bg-canvas-bar text-canvas-fg' : 'seg-track',
        fill && 'flex w-full',
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          aria-label={iconOnly ? o.label : undefined}
          title={o.dot ?? (iconOnly ? o.label : undefined)}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            fill && 'flex-1 justify-center px-2 whitespace-nowrap',
            iconOnly && (size === 'sm' ? 'w-7 justify-center px-0' : 'w-8 justify-center px-0'),
            size === 'sm' ? 'h-7 text-[0.75rem]' : 'h-8 text-[0.8125rem]',
            value === o.id
              ? canvas
                ? 'bg-canvas-sel font-medium text-canvas-strong'
                : 'seg-thumb font-medium'
              : canvas
                ? 'text-canvas-fg hover:text-canvas-strong'
                : 'text-muted hover:text-fg',
          )}
        >
          {o.icon && <o.icon className={iconOnly ? 'h-4 w-4' : 'h-3.5 w-3.5'} strokeWidth={1.8} />}
          {!iconOnly && o.label}
          {o.dot && <span aria-label={o.dot} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  )
}
