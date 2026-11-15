import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import type { Task } from '@shared/schema'
import type { TaskLive } from '@shared/live/task-live'
import { liveBusy } from '@shared/live/task-live'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { SIDEBAR_GROUP_LABEL, TaskRow } from '../SidebarTasks'

/** 「最近」一组先露出这么多，其余点「显示全部」 */
const RECENT = 12

/**
 * 当前项目的对话（方案 B，效果图 B）：「进行中」是在执行、等你处理的，「最近」是其余的，都按最近发言排。
 * 只列这一个项目；看别的项目用顶上的项目下拉，看全部用「全部项目」或对话总览
 */
export function ProjectTasks({
  projectId,
  tasks,
  liveOf,
  isUnread,
}: {
  projectId: string
  /** 这个项目没归档的对话，已经按最近发言排好 */
  tasks: Task[]
  liveOf: (t: Task) => TaskLive
  isUnread: (t: Task) => boolean
}) {
  const { route, go } = useNav()
  const [all, setAll] = useState(false)
  const active = (tk: Task) => route.page === 'projects' && route.sub === tk.id
  const live = tasks.filter((tk) => {
    const l = liveOf(tk)
    return liveBusy(l) || l.state === 'needs'
  })
  const rest = tasks.filter((tk) => !live.includes(tk))
  // 收起「显示全部」时也要露出正在看的那个对话
  const shown = all ? rest : rest.filter((tk, i) => i < RECENT || active(tk))
  const row = (tk: Task) => (
    <TaskRow
      key={tk.id}
      task={tk}
      active={active(tk)}
      unread={isUnread(tk)}
      onOpen={() => go({ page: 'projects', id: projectId, sub: tk.id })}
      onDeleted={() => active(tk) && go({ page: 'projects', id: projectId })}
      className="px-2.5"
    />
  )
  if (!tasks.length)
    return (
      <button
        type="button"
        onClick={() => go({ page: 'projects', id: projectId })}
        className="mx-0.5 mt-2 flex flex-col items-center gap-2 rounded-lg px-4 py-6 text-center text-xs leading-relaxed text-subtle transition-colors hover:bg-hover"
      >
        <MessageSquarePlus className="h-5 w-5" strokeWidth={2} />
        {t('这个项目还没有对话，点这里新建一个。')}
      </button>
    )
  return (
    <div data-project-tasks className="flex flex-col gap-px">
      {live.length > 0 && (
        <>
          <GroupLabel>{t('进行中')}</GroupLabel>
          {live.map(row)}
        </>
      )}
      {rest.length > 0 && (
        <>
          <GroupLabel>{t('最近')}</GroupLabel>
          {shown.map(row)}
          {rest.length > RECENT && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="h-7 cursor-pointer rounded-lg px-2.5 text-left text-xs text-subtle transition-colors hover:bg-sel hover:text-fg"
            >
              {all ? t('收起') : t('显示全部 {n} 个', { n: rest.length })}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function GroupLabel({ children }: { children: string }) {
  return <p className={cn('flex h-7 shrink-0 items-center px-2.5 pt-1', SIDEBAR_GROUP_LABEL)}>{children}</p>
}
