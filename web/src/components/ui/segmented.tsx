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
  options: { id: T; label: string; disabled?: boolean }[]
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
          className={cn(
            'h-8 cursor-pointer rounded-md px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            value === o.id ? 'bg-card font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
