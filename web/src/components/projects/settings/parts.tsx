import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** 每个设置页顶上的标题和一句说明 */
export function PageIntro({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col gap-1 pb-1">
      <h3 className="text-heading font-semibold">{title}</h3>
      <p className="text-footnote leading-relaxed text-subtle">{desc}</p>
    </div>
  )
}

/** 可以折叠的卡片：标题行常驻（图标、名称、说明、角标、操作），内容点开才显示 */
export function Collapsible({
  leading,
  title,
  subtitle,
  badge,
  actions,
  defaultOpen = false,
  children,
}: {
  leading?: React.ReactNode
  title: string
  subtitle?: string
  badge?: string
  actions?: React.ReactNode
  defaultOpen?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Card as="section">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')}
            strokeWidth={2.3}
          />
          {leading}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-medium">{title}</span>
            {subtitle && <span className="truncate text-caption text-subtle">{subtitle}</span>}
          </span>
          {badge && (
            <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-caption text-accent-text">
              {badge}
            </span>
          )}
        </button>
        {actions}
      </div>
      {open && children && <div className="border-t px-3.5 py-3.5">{children}</div>}
    </Card>
  )
}
