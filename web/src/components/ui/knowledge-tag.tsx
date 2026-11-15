import { Compass, ShieldAlert } from 'lucide-react'
import type { ToolUse } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { CHIP_TONE } from './chip-tone'

export type KnowledgeTagItem = NonNullable<ToolUse['knowledge']>[number]

const WHY: Record<KnowledgeTagItem['why'], () => string> = {
  command: () => t('跑命令前推送'),
  path: () => t('改文件前推送'),
  error: () => t('报错后按报错内容推送'),
  search: () => t('搜索前推送'),
}

/**
 * 面板推给模型的项目教训、经验：画在那一行工具调用下面，一眼看得到「这一步用上了哪条」（设计稿一期 ⑦）。
 * 教训用警示色、经验用指路的青色，外形和行内卡片一样（圆角、细内框读 --c-chip-*，设置 → 组件里能调）
 */
export function KnowledgeTags({ items, className }: { items: KnowledgeTagItem[]; className?: string }) {
  if (!items.length) return null
  return (
    <div className={cn('flex flex-wrap gap-1 pt-0.5 pb-1 pl-7', className)}>
      {items.map((k) => {
        const lesson = k.kind === 'lesson'
        const c = CHIP_TONE[lesson ? 'workflow' : 'image']
        const Icon = lesson ? ShieldAlert : Compass
        return (
          <span
            key={`${k.kind}-${k.id}`}
            title={`${WHY[k.why]()} · ${k.title}（id: ${k.id}）`}
            className={cn(
              'inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-(--c-chip-radius) px-1.5 text-caption leading-none ring-(length:--c-chip-ring) ring-inset',
              c.box,
            )}
          >
            <Icon className={cn('h-3 w-3 shrink-0', c.icon)} />
            <span className={cn('shrink-0', c.status)}>{lesson ? t('教训') : t('经验')}</span>
            <span className="min-w-0 truncate text-muted">{k.title}</span>
          </span>
        )
      })}
    </div>
  )
}
