import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ChipOption<T extends string> {
  id: T
  label: string
  icon?: ReactNode
  disabled?: boolean
  /** 悬停提示（选项名放不下的说明） */
  title?: string
}

type Single<T extends string> = { multiple?: false; value: T; onChange: (v: T) => void }
type Multiple<T extends string> = { multiple: true; value: T[]; onChange: (v: T[]) => void }

/**
 * 选择小块组（星期、标签、筛选条件）：一块一个选项，可以折行；和 Segmented 的区别是选项多、可多选。
 * 没选中是浅灰块（深色下提亮，见 index.css 的 chip-idle），选中换强调色浅底 + 强调色字；不描边，靠底色分。
 * 单选按 radiogroup / radio 读，多选按 group + aria-pressed 读
 */
export function ChipGroup<T extends string>(
  props: {
    options: ChipOption<T>[]
    /** 读屏名 */
    label: string
    size?: 'sm' | 'md'
    className?: string
  } & (Single<T> | Multiple<T>),
) {
  const { options, label, size = 'md', className } = props
  const isOn = (id: T) => (props.multiple ? props.value.includes(id) : props.value === id)
  const toggle = (id: T) => {
    if (props.multiple) props.onChange(isOn(id) ? props.value.filter((v) => v !== id) : [...props.value, id])
    else props.onChange(id)
  }
  return (
    <div
      role={props.multiple ? 'group' : 'radiogroup'}
      aria-label={label}
      className={cn('flex flex-wrap items-center', size === 'sm' ? 'gap-1' : 'gap-1.5', className)}
    >
      {options.map((o) => {
        const on = isOn(o.id)
        return (
          <button
            key={o.id}
            type="button"
            role={props.multiple ? undefined : 'radio'}
            aria-checked={props.multiple ? undefined : on}
            aria-pressed={props.multiple ? on : undefined}
            disabled={o.disabled}
            title={o.title}
            onClick={() => toggle(o.id)}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 rounded-md whitespace-nowrap transition-colors outline-none',
              'focus-visible:ring-2 focus-visible:ring-focus-soft disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'h-6 px-2 text-[0.75rem]' : 'h-7 px-2.5 text-[0.8125rem]',
              on ? 'bg-accent-soft font-medium text-accent-text' : 'chip-idle text-muted hover:text-fg',
            )}
          >
            {o.icon && <span className="flex shrink-0 items-center">{o.icon}</span>}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
