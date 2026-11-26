import { useState } from 'react'
import { ChevronDown, MessageSquarePlus } from 'lucide-react'
import type { Task } from '@shared/schema'
import type { TaskLive } from '@shared/live/task-live'
import { t } from '@shared/i18n'
import { askedAt } from '@shared/task'
import { useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { SIDEBAR_GROUP_LABEL, TaskRow } from '../SidebarTasks'
import { projectDayBuckets } from './project-day-buckets'
import { inProgress } from './in-progress'

/** 「更早」展开过就记住，下次打开面板还是展开的；默认收起，只露最近三天 */
const OLDER_OPEN_KEY = 'sidebar-project-older-open'

/**
 * 当前项目的对话（方案 B，效果图 B）：「进行中」是在执行、等你处理、失败和计划卡住的（见 inProgress），其余的按最近发言分成
 * 「今天 / 昨天 / 前天」各一组，再早的收进一个可展开的「更早」，组内都按最近发言排。
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
  const [olderOpen, setOlderOpen] = useState(() => {
    try {
      return localStorage.getItem(OLDER_OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleOlder = () =>
    setOlderOpen((v) => {
      try {
        localStorage.setItem(OLDER_OPEN_KEY, v ? '' : '1')
      } catch {}
      return !v
    })
  const active = (tk: Task) => route.page === 'projects' && route.sub === tk.id
  const live = tasks.filter((tk) => inProgress(tk, liveOf(tk)))
  const days = projectDayBuckets(
    tasks.filter((tk) => !live.includes(tk)),
    askedAt,
  )
  const row = (tk: Task, timeOnly = false) => (
    <TaskRow
      key={tk.id}
      task={tk}
      active={active(tk)}
      unread={isUnread(tk)}
      timeOnly={timeOnly}
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
          {live.map((tk) => row(tk))}
        </>
      )}
      {days.map((d) =>
        d.recent ? (
          <div key={d.key} data-project-day={d.key} className="flex flex-col gap-px">
            <GroupLabel>{d.label}</GroupLabel>
            {d.items.map((tk) => row(tk, true))}
          </div>
        ) : (
          <div key={d.key} data-project-day={d.key} className="flex flex-col gap-px">
            <button
              type="button"
              onClick={toggleOlder}
              aria-expanded={olderOpen}
              className={cn(
                'group/day flex h-7 shrink-0 cursor-pointer items-center gap-1 px-2.5 pt-1 transition-colors hover:text-fg',
                SIDEBAR_GROUP_LABEL,
              )}
            >
              <span className="truncate">{d.label}</span>
              <span className="shrink-0 tabular-nums">· {d.items.length}</span>
              <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', !olderOpen && '-rotate-90')} />
            </button>
            {/* 收起时也要露出正在看的那个对话，不然点开一个旧对话后侧栏里找不到它 */}
            {(olderOpen ? d.items : d.items.filter(active)).map((tk) => row(tk))}
          </div>
        ),
      )}
    </div>
  )
}

function GroupLabel({ children }: { children: string }) {
  return <p className={cn('flex h-7 shrink-0 items-center px-2.5 pt-1', SIDEBAR_GROUP_LABEL)}>{children}</p>
}
