import { cn } from '@/lib/utils'

/** 分段单选：选项少、想一眼看全时用，比下拉框直观 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
}: {
  value: T
  onChange: (v: T) => void
  /** dot：选项上的提示点（例如那一页有要处理的事），文字放在悬停提示里 */
  options: { id: T; label: string; disabled?: boolean; dot?: string }[]
  label: string
  /** 撑满一行、换底色等版式调整；不传时和原来一样 */
  className?: string
  /** sm：页头工具条里用（比如计划页的「周 / 月 / 列表」），和 sm 按钮同高 */
  size?: 'sm' | 'md'
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('seg-track inline-flex max-w-full flex-wrap rounded-lg p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          title={o.dot}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            size === 'sm' ? 'h-7 text-[0.75rem]' : 'h-8 text-[0.8125rem]',
            value === o.id ? 'seg-thumb font-medium' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
          {o.dot && <span aria-label={o.dot} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  )
}
