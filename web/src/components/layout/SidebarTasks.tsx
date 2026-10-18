import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  Check,
  ListFilter,
  Search,
  PencilLine,
  Trash2,
  Pause,
  Play,
  X,
} from 'lucide-react'
import type { Task } from '@shared/schema'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { TaskStatusIcon } from '@/components/tasks/TaskStatusIcon'
import { useTaskControl } from '@/components/tasks/TaskControl'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@/components/ui/menu'
import { ConfirmDialog } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { t } from '@shared/i18n'

// 侧栏里的任务列表：一行任务、搜索和筛选、聊天列表

export function shortTime(iso: string) {
  const d = new Date(iso)
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
  className,
}: {
  task: Task
  active: boolean
  onOpen: () => void
  onDeleted: () => void
  /** 时间前面的小字，搜索结果里显示所属项目 */
  hint?: string
  className?: string
}) {
  const { removeTask, upsertTask } = useData()
  const control = useTaskControl(task)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const chat = !task.projectId
  const rename = async (title: string) => {
    setRenaming(false)
    title = title.trim()
    if (!title || title === task.title) return
    try {
      upsertTask(await api.renameTask(task.id, title))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const archive = async (archived: boolean) => {
    try {
      upsertTask(await api.archiveTask(task.id, archived))
      toast.success(archived ? t('已归档，可以在筛选里选「已归档」找到') : t('已取消归档'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async () => {
    try {
      await api.deleteTask(task.id)
      removeTask(task.id)
      onDeleted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }
  if (renaming)
    return (
      <input
        autoFocus
        aria-label={chat ? t('聊天标题') : t('任务标题')}
        defaultValue={task.title}
        maxLength={80}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => rename(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setRenaming(false)
        }}
        className="h-8 rounded-lg border border-accent bg-field px-2 text-[13px] text-fg outline-none"
      />
    )
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={onOpen}
            aria-current={active || undefined}
            title={task.title}
            className={cn(
              'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg text-left text-[13px] transition-colors',
              active ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
              className,
            )}
          >
            {task.requests?.length ? (
              // Agent 在等你确认操作或回答问题
              <CircleAlert
                aria-label={t('需要你处理')}
                className="h-3.5 w-3.5 shrink-0 text-warning"
                strokeWidth={2.4}
              />
            ) : task.status === 'running' || task.status === 'failed' ? (
              <TaskStatusIcon status={task.status} className="h-3.5 w-3.5" />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            {hint && <span className="max-w-[40%] shrink truncate text-[11px] text-subtle">{hint}</span>}
            <span className="shrink-0 text-[11px] text-subtle tabular-nums">{shortTime(task.updatedAt)}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {control.action && (
            <>
              <ContextMenuItem disabled={control.busy} onSelect={control.run}>
                {control.action === 'pause' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {control.label}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => setRenaming(true)}>
            <PencilLine className="h-4 w-4" />
            {t('重命名')}
          </ContextMenuItem>
          {task.archived ? (
            <ContextMenuItem onSelect={() => archive(false)}>
              <ArchiveRestore className="h-4 w-4" />
              {t('取消归档')}
            </ContextMenuItem>
          ) : (
            <ContextMenuItem disabled={task.status === 'running'} onSelect={() => archive(true)}>
              <Archive className="h-4 w-4" />
              {t('归档')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={() => setDeleting(true)}>
            <Trash2 className="h-4 w-4" />
            {t('删除')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除「{name}」？', { name: task.title })}
        description={chat ? t('这次聊天的记录会一起删除。') : t('任务的记录会一起删除，项目里的文件不受影响。')}
        onConfirm={remove}
      />
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
  if (filter === 'running' && tk.status !== 'running') return false
  if (filter === 'failed' && tk.status !== 'failed') return false
  if (filter === 'waiting' && !tk.requests?.length) return false
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
      <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-transparent bg-field/70 px-2 text-[13px] focus-within:border-accent/60 focus-within:bg-field">
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

/** Chat 模式的侧栏：最近的聊天，右键可以重命名、归档、删除 */
export function ChatList() {
  const { route, go } = useNav()
  const { tasks } = useData()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const chats = tasks
    .filter((t) => !t.projectId && matchTask(t, query, filter))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const filtering = !!query.trim() || filter !== 'all'
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <TaskSearch query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} placeholder={t('搜索聊天')} />
      <p className="flex h-7 shrink-0 items-center px-2.5 text-xs text-subtle">
        {filtering ? t('找到 {n} 个', { n: chats.length }) : t('最近')}
      </p>
      {chats.length === 0 && (
        <p className="px-2.5 py-1 text-xs text-subtle">{filtering ? t('没有符合的聊天。') : t('还没有聊天。')}</p>
      )}
      <div className="flex flex-col gap-px">
        {chats.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            active={route.page === 'chat' && route.id === t.id}
            onOpen={() => go({ page: 'chat', id: t.id })}
            onDeleted={() => route.page === 'chat' && route.id === t.id && go({ page: 'chat' })}
            className="px-2.5"
          />
        ))}
      </div>
    </div>
  )
}

/** 左侧栏：参考 Claude Code，上面是新建和导航，中间是最近任务，下面是设置 */
