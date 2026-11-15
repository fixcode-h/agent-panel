import type { HTMLAttributes, ReactNode } from 'react'
import { Folder, GripVertical } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Card } from './card'
import { SIDEBAR_GROUP_LABEL } from './sidebar'

/**
 * 「全部项目」页的项目卡片（设计稿方案 C 的 C2，方案 B 的下拉里「全部项目」打开它）：
 * 项目名、路径、分类，行尾状态，下面是最近几个对话。整张可点打开项目；右上角是更多菜单，左上角悬停出拖动手柄
 */
export function ProjectCard({
  name,
  path,
  category,
  status,
  recent,
  more,
  handle,
  on,
  onOpen,
  className,
}: {
  name: ReactNode
  path?: string
  category?: string
  status?: ReactNode
  /** 最近几个对话的标题 */
  recent?: string[]
  /** 右上角的更多菜单（触发按钮由调用方给） */
  more?: ReactNode
  /** 拖动手柄的属性（useDragSort 的 itemProps 加上读屏名），不给就不能拖 */
  handle?: HTMLAttributes<HTMLSpanElement>
  /** 侧栏上的当前项目：文件夹图标是项目蓝 */
  on?: boolean
  onOpen: () => void
  className?: string
}) {
  return (
    <Card
      as="article"
      padding="sm"
      interactive
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn('group/card flex min-w-0 flex-col gap-2', className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {handle && (
          <span
            {...handle}
            role="button"
            tabIndex={0}
            onClick={(e) => e.stopPropagation()}
            className="-ml-1 grid h-6 w-4 shrink-0 cursor-grab place-items-center rounded-sm text-subtle opacity-0 group-hover/card:opacity-60 hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        )}
        <Folder className={cn('h-4 w-4 shrink-0', on ? 'text-proj-ico' : 'text-subtle')} strokeWidth={2.2} />
        <span className="min-w-0 flex-1 truncate text-prose font-semibold">{name}</span>
        {status}
        {more && (
          // 菜单里的点击不冒泡到卡片：不然点「重命名」会顺手打开项目
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {more}
          </span>
        )}
      </div>
      {(path || category) && (
        <p className="flex min-w-0 items-center gap-1.5 text-caption text-subtle">
          {category && <span className="shrink-0 rounded-sm bg-sel px-1.5 py-px text-muted">{category}</span>}
          {path && <span className="min-w-0 truncate font-mono">{path}</span>}
        </p>
      )}
      <div className="flex min-h-[4.5rem] flex-col gap-0.5 border-t border-line pt-2">
        {recent?.length ? (
          recent.map((title, i) => (
            <span key={i} className="truncate text-body text-muted">
              {title}
            </span>
          ))
        ) : (
          <span className={SIDEBAR_GROUP_LABEL}>{t('还没有对话')}</span>
        )}
      </div>
    </Card>
  )
}
