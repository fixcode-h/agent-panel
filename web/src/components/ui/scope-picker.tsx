import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from './badge'

export interface ScopeOption<T extends string> {
  id: T
  icon: LucideIcon
  title: string
  /** 存到哪、给谁用：一两句 */
  desc: ReactNode
  /** 再小一号的补充（P4 会先签出这类） */
  note?: string
  badge?: string
  disabled?: boolean
}

/**
 * 「存到哪」的单选卡片（自建工具保存弹窗用；经验、Skill 以后的「存到项目还是全局」也用它）：
 * 并排两三张卡片，选中的描强调色边、淡强调色底。外观跟卡片和小标签的调节走（设置 → 组件）
 */
export function ScopePicker<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: ScopeOption<T>[]
  /** 读屏用的组名 */
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2.5 sm:grid-cols-2">
      {options.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              'flex min-w-0 items-start gap-2.5 rounded-(--c-card-radius) border bg-card px-3 py-2.5 text-left transition-colors',
              on ? 'border-accent bg-accent-soft/40 ring-1 ring-accent ring-inset' : 'border-line hover:bg-hover',
              o.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <span
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border',
                on ? 'border-[4px] border-accent' : 'border-line-strong',
              )}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-body font-medium">
                <o.icon className="h-3.5 w-3.5 text-muted" />
                {o.title}
                {o.badge && <Badge tone="accent">{o.badge}</Badge>}
              </span>
              <span className="text-footnote text-muted">{o.desc}</span>
              {o.note && <span className="text-caption text-subtle">{o.note}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}
