import { Fragment } from 'react'
import { Compass, ShieldAlert } from 'lucide-react'
import type { ToolUse } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

export type KnowledgeTagItem = NonNullable<ToolUse['knowledge']>[number]

const WHY: Record<KnowledgeTagItem['why'], () => string> = {
  command: () => t('跑命令前推送'),
  path: () => t('改文件前推送'),
  error: () => t('报错后按报错内容推送'),
  search: () => t('搜索前推送'),
}

/**
 * 面板推给模型的项目教训、经验：画在那一行工具调用下面，一眼看得到「这一步用上了哪条」（设计稿一期 ⑦）。
 * 用户嫌带框的色块抢眼：改成工具行下面一行很轻的次要小字，左边和工具行的动作名对齐（过程行 pl-2 + 图标 + gap-2），
 * 只有前面的小图标带一点颜色（教训警示色、经验指路的青色），多条用「·」隔开、各自截短，悬停看推送时机和标题全文
 */
export function KnowledgeTags({ items, className }: { items: KnowledgeTagItem[]; className?: string }) {
  if (!items.length) return null
  return (
    <div
      data-knowledge-tags=""
      className={cn('flex min-w-0 items-center gap-1.5 overflow-hidden pr-2 pl-7.5 text-caption leading-5', className)}
    >
      {items.map((k, i) => {
        const lesson = k.kind === 'lesson'
        const Icon = lesson ? ShieldAlert : Compass
        return (
          <Fragment key={`${k.kind}-${k.id}`}>
            {i > 0 && (
              <span aria-hidden className="shrink-0 text-subtle/60">
                ·
              </span>
            )}
            <span
              title={`${WHY[k.why]()} · ${lesson ? t('教训') : t('经验')}：${k.title}（id: ${k.id}）`}
              className="inline-flex min-w-0 items-center gap-1 text-subtle"
            >
              <Icon className={cn('h-3 w-3 shrink-0', lesson ? 'text-warning/80' : 'text-run/80')} />
              <span className="shrink-0">{lesson ? t('教训') : t('经验')}</span>
              <span className="min-w-0 truncate">{k.title}</span>
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}
