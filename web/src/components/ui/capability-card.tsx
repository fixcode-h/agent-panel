import type { ComponentType, ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * 项目能力卡（项目设置 →「能力」的插件块，设计稿：Agent侧栏与项目管理重设计 6.3）：图标、名称、开关，
 * 下面一句作用，再下面是推荐理由或已设置的情况；打开了但还缺设置时最后一行换成琥珀色「还缺…」和「去设置」。
 * 外观跟卡片、开关、小标签的调节走（设置 → 组件）
 */
export function CapabilityCard({
  icon: Icon,
  name,
  description,
  on,
  onChange,
  badge,
  note,
  missing,
  onFix,
  fixLabel,
  disabled,
  error,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  name: string
  description: string
  on: boolean
  onChange: (on: boolean) => void
  /** 名称后面的小标签（「推荐」） */
  badge?: string
  /** 推荐理由、已设置的情况，或者为什么开不了（全局关着） */
  note?: ReactNode
  /** 打开了但还缺的设置；只在打开时显示 */
  missing?: string
  onFix?: () => void
  fixLabel?: string
  /** 开不了（插件全局关着）：开关灰掉，note 里写原因 */
  disabled?: boolean
  /** 探查出错的原文 */
  error?: string
}) {
  return (
    <Card padding="md" className={cn('flex min-w-0 flex-col gap-2', disabled && 'opacity-70')}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sel/70 text-muted">
          <Icon className="h-4 w-4" strokeWidth={2} />
        </span>
        <span className="min-w-0 truncate text-body font-medium">{name}</span>
        {badge && <Badge tone="accent">{badge}</Badge>}
        <Switch className="ml-auto" checked={on} disabled={disabled} onCheckedChange={onChange} aria-label={name} />
      </div>
      <p className="text-footnote leading-relaxed text-muted">{description}</p>
      {note && <div className="text-footnote leading-relaxed text-subtle">{note}</div>}
      {error && <p className="text-footnote leading-relaxed break-all text-danger">{error}</p>}
      {on && missing && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-warning">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
          <span className="min-w-0 flex-1">{missing}</span>
          {onFix && fixLabel && (
            <Button variant="link" tone="warning" onClick={onFix}>
              {fixLabel}
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
