import { cn } from '@/lib/utils'

/** 分段单选：选项少、想一眼看全时用，比下拉框直观 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  /** dot：选项上的提示点（例如那一页有要处理的事），文字放在悬停提示里 */
  options: { id: T; label: string; disabled?: boolean; dot?: string }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-lg bg-field p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          title={o.dot}
          className={cn(
            'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[0.8125rem] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            value === o.id ? 'bg-card font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
          {o.dot && <span aria-label={o.dot} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  )
}
