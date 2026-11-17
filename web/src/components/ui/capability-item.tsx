import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

/**
 * 能力条目（一个技能或一个 MCP 工具），项目「能力」页和「技能与 MCP」页共用（设计稿 B3、6.3）：
 * 左边图标、名称、类型小标签和一句说明，右边写来源（文件或「面板自带」）和谁能读到，最右是开关、「全局」标签或操作。
 * 外观跟卡片、小标签的调节走（设置 → 组件）
 */
export function CapabilityItem({
  icon: Icon,
  name,
  kind,
  description,
  where,
  whereNote,
  trailing,
  muted,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  name: string
  /** 类型小标签：技能、MCP */
  kind?: string
  description?: string
  /** 来源：项目里的文件（等宽字）或「面板自带」这类说法 */
  where?: string
  /** 来源下面一行：哪些 Agent 能读到、识别到没导入 */
  whereNote?: string
  trailing?: ReactNode
  /** 关着的条目：淡一点 */
  muted?: boolean
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2', muted && 'opacity-60')}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sel/70 text-muted">
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-body font-medium">{name}</span>
          {kind && <Badge>{kind}</Badge>}
        </span>
        {description && <span className="truncate text-footnote text-subtle">{description}</span>}
      </span>
      {(where || whereNote) && (
        <span className="hidden max-w-[45%] shrink-0 flex-col items-end text-right text-caption text-subtle sm:flex">
          {where && (
            <span className="truncate font-mono" title={where}>
              {where}
            </span>
          )}
          {whereNote && (
            <span className="truncate" title={whereNote}>
              {whereNote}
            </span>
          )}
        </span>
      )}
      {trailing && <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>}
    </div>
  )
}

/** 一组能力条目：卡片底，行之间不画线（靠留白分开），和设置页其他列表一致 */
export function CapabilityItemList({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <Card padding="xs" className="flex flex-col">
      {children}
      {footer && <div className="px-2.5 pt-1 pb-1.5">{footer}</div>}
    </Card>
  )
}

/** 一块的标题：名称、计数、右边的操作（「从全局库添加」「去全局管理」） */
export function CapabilityBlockHeader({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1">
      <h3 className="text-body font-semibold">{title}</h3>
      {meta && <span className="text-footnote text-subtle">{meta}</span>}
      {action && <span className="ml-auto flex items-center gap-2">{action}</span>}
    </div>
  )
}
