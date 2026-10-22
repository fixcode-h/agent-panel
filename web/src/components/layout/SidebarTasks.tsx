import { useState } from 'react'
import { Check, ChevronDown, CircleAlert, ListFilter, MessageSquare, Search, Workflow, X } from 'lucide-react'
import type { Task } from '@shared/schema'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { TaskStatusIcon } from '@/components/tasks/TaskStatusIcon'
import { TaskRenameInput, useTaskRowMenu } from '@/components/tasks/TaskMenu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@/components/ui/menu'
import { t } from '@shared/i18n'
import { askedAt, byAskedAt, groupByDay, taskBusy } from '@shared/task'

// 侧栏里的任务列表：一行任务、搜索和筛选、聊天列表

/** timeOnly：分组已经写了日期，行里只留时分 */
export function shortTime(iso: string, timeOnly = false) {
  const d = new Date(iso)
  if (timeOnly) return d.toTimeString().slice(0, 5)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // 跨夏令时的那天相差 23 / 25 小时，取整
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000)
  if (diff <= 0) return d.toTimeString().slice(0, 5)
  if (diff === 1) return t('昨天')
  if (diff < 7) return t('{n} 天前', { n: diff })
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 每个项目默认显示的任务数，多的点「更多」展开 */

export function TaskRow({
  task,
  active,
  onOpen,
  onDeleted,
  hint,
  unread,
  timeOnly,
  className,
}: {
  task: Task
  active: boolean
  onOpen: () => void
  onDeleted: () => void
  /** 时间前面的小字，搜索结果里显示所属项目 */
  hint?: string
  /** 项目里的对话完成了、用户还没打开看过 */
  unread?: boolean
  /** 分组已经写了日期，行里只显示时分 */
  timeOnly?: boolean
  className?: string
}) {
  const menu = useTaskRowMenu(task, onDeleted)
  if (menu.renaming)
    return <TaskRenameInput task={task} onCommit={menu.rename} onCancel={() => menu.setRenaming(false)} />
  // 自己在执行、名下子对话在执行、或者在等派出的子任务：都算「还在跑」（转圈）
  const busy = taskBusy(task)
  // CLI 进程还开着（等下一句、预热）但没在处理这一轮：用虚线边框表示，前面的对话 / 工作流图标一直显示
  const online = task.status === 'running' && !busy
  const ModeIcon = task.mode === 'workflow' ? Workflow : MessageSquare
  const attention = task.requests?.length ? 'ask' : busy ? 'running' : task.status === 'failed' ? 'failed' : ''
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={onOpen}
            aria-current={active || undefined}
            title={task.title}
            data-cli-online={online || undefined}
            className={cn(
              'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border border-transparent text-left text-[0.8125rem] transition-colors',
              active ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
              online && 'border-dashed border-line-strong',
              className,
            )}
          >
            {unread && (
              <span
                role="img"
                aria-label={t('对话已完成，还没查看')}
                title={t('对话已完成，还没查看')}
                className="h-2 w-2 shrink-0 rounded-full bg-accent"
              />
            )}
            <span className="flex shrink-0 items-center gap-1">
              <ModeIcon
                aria-label={task.mode === 'workflow' ? t('工作流') : t('对话')}
                className="h-3.5 w-3.5 text-subtle"
              />
              {attention === 'ask' ? (
                // Agent 在等你确认操作或回答问题
                <CircleAlert
                  aria-label={t('需要你处理')}
                  className="h-3.5 w-3.5 shrink-0 text-warning"
                  strokeWidth={2.4}
                />
              ) : attention === 'running' || attention === 'failed' ? (
                <TaskStatusIcon
                  status={attention === 'running' ? 'running' : task.status}
                  working={attention === 'running'}
                  className="h-3.5 w-3.5"
                />
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            {hint && <span className="max-w-[40%] shrink truncate text-[0.6875rem] text-subtle">{hint}</span>}
            <span className="shrink-0 text-[0.6875rem] text-subtle tabular-nums">
              {shortTime(askedAt(task), timeOnly)}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>{menu.items}</ContextMenuContent>
      </ContextMenu>
      {menu.confirm}
    </>
  )
}

export type TaskFilter = 'all' | 'running' | 'failed' | 'waiting' | 'archived'
export const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: t('全部') },
  { id: 'running', label: t('执行中') },
  { id: 'failed', label: t('失败') },
  { id: 'waiting', label: t('等我处理') },
  { id: 'archived', label: t('已归档') },
]

/** 按标题和第一条要求搜索，按状态筛选；归档的只在「已归档」里出现 */
export function matchTask(tk: Task, query: string, filter: TaskFilter) {
  if (filter === 'archived' ? !tk.archived : tk.archived) return false
  if (filter === 'running' && !taskBusy(tk)) return false
  if (filter === 'failed' && tk.status !== 'failed') return false
  if (filter === 'waiting' && !tk.requests?.length && !tk.awaitingUser) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  const first = tk.messages.find((m) => m.role === 'user')?.text ?? ''
  return tk.title.toLowerCase().includes(q) || first.toLowerCase().includes(q)
}

/** 侧栏顶部的搜索框和筛选 */
export function TaskSearch({
  query,
  onQuery,
  filter,
  onFilter,
  placeholder,
}: {
  query: string
  onQuery: (q: string) => void
  filter: TaskFilter
  onFilter: (f: TaskFilter) => void
  placeholder: string
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 px-0.5 pb-1">
      <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-transparent bg-field/70 px-2 text-[0.8125rem] focus-within:border-focus/60 focus-within:bg-field">
        <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <input
          id="sidebar-search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && (query || filter !== 'all')) {
              e.stopPropagation()
              onQuery('')
              onFilter('all')
              e.currentTarget.blur()
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle"
        />
        {query && (
          <button
            onClick={() => onQuery('')}
            aria-label={t('清除搜索')}
            className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:text-fg"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </label>
      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label={t('筛选')}
            title={filter === 'all' ? t('筛选') : FILTERS.find((f) => f.id === filter)?.label}
            className={cn(
              'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors',
              filter === 'all' ? 'text-subtle hover:bg-sel hover:text-fg' : 'bg-accent-soft text-accent',
            )}
          >
            <ListFilter className="h-3.5 w-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          {FILTERS.map((f) => (
            <MenuItem key={f.id} onSelect={() => onFilter(f.id)}>
              <Check className={cn('h-4 w-4', f.id !== filter && 'invisible')} />
              {f.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  )
}

/** 收起的「按日分组」记在本机浏览器里，下次打开还是收起的 */
function useFoldedDays() {
  const [v, set] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('sidebar-chat-days') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggle = (key: string) =>
    set((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      try {
        localStorage.setItem('sidebar-chat-days', JSON.stringify([...next]))
      } catch {}
      return next
    })
  return [v, toggle] as const
}

/** Chat 模式的侧栏：聊天按天分组，组可以收起；右键可以重命名、归档、删除 */
export function ChatList() {
  const { route, go } = useNav()
  const { tasks } = useData()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [folded, toggleDay] = useFoldedDays()
  const chats = tasks.filter((x) => !x.projectId && matchTask(x, query, filter)).sort(byAskedAt)
  const filtering = !!query.trim() || filter !== 'all'
  const days = groupByDay(chats, askedAt)
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <TaskSearch query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} placeholder={t('搜索聊天')} />
      <p className="flex h-7 shrink-0 items-center px-2.5 text-xs text-subtle">
        {filtering ? t('找到 {n} 个', { n: chats.length }) : t('最近')}
      </p>
      {chats.length === 0 && (
        <p className="px-2.5 py-1 text-xs text-subtle">{filtering ? t('没有符合的聊天。') : t('还没有聊天。')}</p>
      )}
      {days.map((d) => {
        const open = !folded.has(d.key)
        return (
          <div key={d.key} className="flex flex-col gap-px">
            <button
              onClick={() => toggleDay(d.key)}
              aria-expanded={open}
              className="flex h-7 shrink-0 cursor-pointer items-center gap-1 px-2.5 text-xs text-subtle hover:text-fg"
            >
              <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', !open && '-rotate-90')} />
              <span className="truncate">{d.label}</span>
              <span className="shrink-0">· {d.items.length}</span>
            </button>
            {open &&
              d.items.map((tk) => (
                <TaskRow
                  key={tk.id}
                  task={tk}
                  timeOnly
                  active={route.page === 'chat' && route.id === tk.id}
                  onOpen={() => go({ page: 'chat', id: tk.id })}
                  onDeleted={() => route.page === 'chat' && route.id === tk.id && go({ page: 'chat' })}
                  className="px-2.5"
                />
              ))}
          </div>
        )
      })}
    </div>
  )
}

/** 左侧栏：参考 Claude Code，上面是新建和导航，中间是最近任务，下面是设置 */
