import { useEffect, useState } from 'react'
import { useEscape } from '@/lib/useEscape'
import {
  Archive,
  ArchiveRestore,
  BellRing,
  Bot,
  Check,
  ListFilter,
  Search,
  Code2,
  MessagesSquare,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Layers,
  MessageSquarePlus,
  PencilLine,
  Settings2,
  Trash2,
  Menu as MenuIcon,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  Settings,
  Sun,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { useData, useNav, type PageId, type Route } from '@/lib/data'
import { cn } from '@/lib/utils'
import { useAppUpdate } from '@/lib/app-update'
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

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent text-white', className)}>
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="5.5" r="2.4" />
        <circle cx="5.5" cy="18" r="2.4" />
        <circle cx="18.5" cy="18" r="2.4" />
        <path d="M12 8v3.5M12 11.5 6.8 15.8M12 11.5l5.2 4.3" />
      </svg>
    </span>
  )
}

const NAV: { id: PageId; label: string; icon: LucideIcon }[] = [
  { id: 'agents', label: 'Agent', icon: Bot },
  { id: 'workflows', label: t('工作流'), icon: Workflow },
]

/** 侧栏任务的更新时间：今天显示时刻，其余显示几天前或日期 */
function shortTime(iso: string) {
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
const PER_PROJECT = 5

/** 收起的项目分组记在本机浏览器里 */
function useFolded() {
  const [v, set] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('sidebar-folded') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggle = (id: string) =>
    set((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      try {
        localStorage.setItem('sidebar-folded', JSON.stringify([...next]))
      } catch {}
      return next
    })
  const replace = (next: Set<string>) => {
    set(next)
    try {
      localStorage.setItem('sidebar-folded', JSON.stringify([...next]))
    } catch {}
  }
  return [v, toggle, replace] as const
}

/** 整个「项目」分组收起时记在 folded 里的键 */
const ALL = '__all'

function useCollapsed() {
  const [v, set] = useState(() => {
    try {
      return localStorage.getItem('sidebar') === 'collapsed'
    } catch {
      return false
    }
  })
  const toggle = () => {
    try {
      localStorage.setItem('sidebar', v ? 'open' : 'collapsed')
    } catch {}
    set(!v)
  }
  return [v, toggle] as const
}

function Row({
  icon: Icon,
  label,
  on,
  onClick,
  collapsed,
  className,
  badge,
}: {
  icon: LucideIcon
  label: string
  on?: boolean
  onClick: () => void
  collapsed: boolean
  className?: string
  /** 右上角的提示点，例如有新版本 */
  badge?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
        on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
        collapsed && 'justify-center px-0',
        className,
      )}
    >
      <span className="relative shrink-0">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
        {badge && collapsed && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-rail" />
        )}
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
      {badge && !collapsed && (
        <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[11px] text-accent">
          {badge}
        </span>
      )}
    </button>
  )
}

/** 切到 Agent 模式时回到上次在 Agent 模式里看的页面 */
let lastAgentRoute: Route = { page: 'home' }

/**
 * 顶部的模式切换，参考 Claude 应用：Chat 是不属于项目的聊天，Agent 是按项目执行任务。
 * 收起侧栏时只显示一个按钮，点了切到另一个模式。
 */
function ModeSwitch({ narrow }: { narrow: boolean }) {
  const { route, go } = useNav()
  const chat = route.page === 'chat'
  const modes = [
    {
      id: 'chat',
      label: t('Chat 模式：直接聊天，不用选项目'),
      icon: MessagesSquare,
      on: chat,
      to: { page: 'chat' } as Route,
    },
    { id: 'agent', label: t('Agent 模式：在项目里执行任务和工作流'), icon: Code2, on: !chat, to: lastAgentRoute },
  ]
  if (narrow) {
    const other = modes.find((m) => !m.on)!
    return (
      <button
        onClick={() => go(other.to)}
        aria-label={t('切换到{mode}', { mode: other.label })}
        title={t('切换到{mode}', { mode: other.label })}
        className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel hover:text-fg"
      >
        <other.icon className="h-[17px] w-[17px]" strokeWidth={1.8} />
      </button>
    )
  }
  return (
    <div
      role="radiogroup"
      aria-label={t('模式')}
      className="flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5"
    >
      {modes.map((m) => (
        <button
          key={m.id}
          role="radio"
          aria-checked={m.on}
          aria-label={m.label}
          title={m.label}
          onClick={() => !m.on && go(m.to)}
          className={cn(
            'grid h-6.5 w-7 cursor-pointer place-items-center rounded-md transition-colors',
            m.on ? 'bg-sel text-fg shadow-card' : 'text-subtle hover:text-fg',
          )}
        >
          <m.icon className="h-[15px] w-[15px]" strokeWidth={1.8} />
        </button>
      ))}
    </div>
  )
}

/**
 * 侧栏里的一个任务（聊天）：点击打开，右键可以暂停 / 继续、重命名、删除。
 * 暂停和继续同一时间只显示能用的那个。
 */
function TaskRow({
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
              <BellRing
                aria-label={t('需要你处理')}
                className="h-3.5 w-3.5 shrink-0 animate-[bell_1.6s_ease-in-out_infinite] text-warning"
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

type TaskFilter = 'all' | 'running' | 'failed' | 'waiting' | 'archived'
const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: t('全部') },
  { id: 'running', label: t('执行中') },
  { id: 'failed', label: t('失败') },
  { id: 'waiting', label: t('等我处理') },
  { id: 'archived', label: t('已归档') },
]

/** 按标题和第一条要求搜索，按状态筛选；归档的只在「已归档」里出现 */
function matchTask(tk: Task, query: string, filter: TaskFilter) {
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
function TaskSearch({
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
function ChatList() {
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
export function Sidebar({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { route, go, openSettings, openProject } = useNav()
  const { tasks, projects, setProjects, reloadTasks } = useData()
  // 有可以安装的新版本时在「设置」上提示（在线演示不提示）
  const appUpdate = useAppUpdate().data
  const update = !import.meta.env.VITE_DEMO && appUpdate?.packaged ? appUpdate.update : undefined
  const [collapsed, toggleCollapsed] = useCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => setMobileOpen(false), [route])
  const chatMode = route.page === 'chat'
  if (!chatMode) lastAgentRoute = route
  useEscape(mobileOpen, () => setMobileOpen(false))

  // 按项目分组，最近有动静的项目排在前面；组内按更新时间
  const [folded, toggleFolded, setFolded] = useFolded()
  const [more, setMore] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const filtering = !!query.trim() || filter !== 'all'
  const projectTasks = tasks.filter((t) => t.projectId)
  const found = filtering
    ? projectTasks.filter((t) => matchTask(t, query, filter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : []
  // 归档的不在项目分组里显示
  const recent = projectTasks.filter((t) => !t.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const byProject = new Map<string, Task[]>()
  for (const t of recent) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t])
  // 所有项目都列出来（还没有对话的也在），最近有动静的排前面
  const last = (p: { id: string; updatedAt: string }) => byProject.get(p.id)?.[0]?.updatedAt ?? p.updatedAt
  const groups: [string, Task[]][] = [...projects]
    .sort((a, b) => last(b).localeCompare(last(a)))
    .map((p) => [p.id, byProject.get(p.id) ?? []])
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? t('已删除的项目')
  const allOpen = !folded.has(ALL)
  // 右键菜单里的重命名就地改名，删除先确认
  const [renaming, setRenaming] = useState('')
  const [deleting, setDeleting] = useState<Project>()
  const rename = async (p: Project, name: string) => {
    setRenaming('')
    name = name.trim()
    if (!name || name === p.name) return
    try {
      const { id, createdAt, updatedAt, ...rest } = p
      const saved = await api.updateProject(id, { ...rest, name })
      setProjects((ps) => ps.map((x) => (x.id === saved.id ? saved : x)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async (p: Project) => {
    try {
      await api.deleteProject(p.id)
      setProjects((ps) => ps.filter((x) => x.id !== p.id))
      void reloadTasks()
      toast.success(t('已删除「{name}」', { name: p.name }))
      if (route.page === 'projects' && route.id === p.id) go({ page: 'home' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(undefined)
    }
  }
  const reveal = (p: Project) => {
    if (!p.path) return toast.error(t('这个项目还没有选择本地目录'))
    api.revealProject(p.id).catch((e) => toast.error((e as Error).message))
  }

  const body = (narrow: boolean) => (
    <>
      <div className={cn('flex h-14 shrink-0 items-center gap-1.5 px-3', narrow && 'justify-center px-0')}>
        {!narrow && (
          <button onClick={() => go({ page: 'home' })} className="flex min-w-0 cursor-pointer items-center gap-2.5">
            <Logo />
            <span className="truncate font-serif text-[16px] font-semibold tracking-tight">{t('Agent 面板')}</span>
          </button>
        )}
        {!narrow && (
          <span className="ml-auto">
            <ModeSwitch narrow={false} />
          </span>
        )}
        <button
          onClick={toggleCollapsed}
          aria-label={narrow ? t('展开侧栏') : t('收起侧栏')}
          title={narrow ? t('展开侧栏') : t('收起侧栏')}
          className={cn(
            'hidden h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel hover:text-fg md:grid',
            narrow && 'ml-auto',
          )}
        >
          {narrow ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
        </button>
      </div>

      <nav aria-label={t('主导航')} className={cn('flex flex-col gap-0.5 px-2', narrow && 'items-center')}>
        {narrow && <ModeSwitch narrow />}
        {chatMode ? (
          <Row
            icon={Plus}
            label={t('新建聊天')}
            collapsed={narrow}
            on={!route.id}
            onClick={() => go({ page: 'chat' })}
            className={cn(!narrow && '[&>svg]:rounded-full [&>svg]:bg-accent [&>svg]:p-[3px] [&>svg]:text-white')}
          />
        ) : (
          <>
            <Row
              icon={Plus}
              label={t('新建任务')}
              collapsed={narrow}
              on={route.page === 'home'}
              onClick={() => go({ page: 'home' })}
              className={cn(!narrow && '[&>svg]:rounded-full [&>svg]:bg-accent [&>svg]:p-[3px] [&>svg]:text-white')}
            />
            {NAV.map((n) => (
              <Row
                key={n.id}
                icon={n.icon}
                label={n.label}
                collapsed={narrow}
                on={route.page === n.id}
                onClick={() => go({ page: n.id })}
              />
            ))}
          </>
        )}
      </nav>

      {chatMode ? (
        narrow ? (
          <div className="flex-1" />
        ) : (
          <ChatList />
        )
      ) : !narrow && filtering ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
          <TaskSearch
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            placeholder={t('搜索任务')}
          />
          <p className="flex h-7 shrink-0 items-center px-2.5 text-xs text-subtle">
            {t('找到 {n} 个', { n: found.length })}
          </p>
          {found.length === 0 && <p className="px-2.5 py-1 text-xs text-subtle">{t('没有符合的任务。')}</p>}
          <div className="flex flex-col gap-px">
            {found.map((tk) => (
              <TaskRow
                key={tk.id}
                task={tk}
                hint={projectName(tk.projectId)}
                active={route.page === 'projects' && route.sub === tk.id}
                onOpen={() => go({ page: 'projects', id: tk.projectId, sub: tk.id })}
                onDeleted={() =>
                  route.page === 'projects' && route.sub === tk.id && go({ page: 'projects', id: tk.projectId })
                }
                className="px-2.5"
              />
            ))}
          </div>
        </div>
      ) : !narrow ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
          <TaskSearch
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            placeholder={t('搜索任务')}
          />
          <div className="group/head flex h-7 shrink-0 items-center gap-0.5 pr-1 pl-2.5">
            <button
              onClick={() => toggleFolded(ALL)}
              aria-expanded={allOpen}
              className="flex cursor-pointer items-center gap-1 text-xs text-subtle hover:text-fg"
            >
              {t('项目')}
              <ChevronDown className={cn('h-3 w-3 transition-transform', !allOpen && '-rotate-90')} />
            </button>
            <Menu>
              <MenuTrigger asChild>
                <button
                  aria-label={t('项目菜单')}
                  title={t('更多')}
                  className="ml-auto grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onSelect={() => openProject()}>
                  <FolderPlus className="h-4 w-4" />
                  {t('新建项目')}
                </MenuItem>
                <MenuItem onSelect={() => openSettings('categories')}>
                  <Layers className="h-4 w-4" />
                  {t('管理项目分类')}
                </MenuItem>
                <MenuItem onSelect={() => setFolded(new Set())}>
                  <ChevronsUpDown className="h-4 w-4" />
                  {t('全部展开')}
                </MenuItem>
                <MenuItem onSelect={() => setFolded(new Set(projects.map((p) => p.id)))}>
                  <ChevronsDownUp className="h-4 w-4" />
                  {t('全部收起')}
                </MenuItem>
              </MenuContent>
            </Menu>
            <button
              onClick={() => openProject()}
              aria-label={t('新建项目')}
              title={t('新建项目')}
              className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {allOpen && projects.length === 0 && (
            <p className="px-2.5 pt-1 text-xs leading-relaxed text-subtle">
              {t('还没有项目。点右边的 + 添加一个本机目录，再在项目里新建对话。')}
            </p>
          )}
          {allOpen &&
            groups.map(([pid, ts]) => {
              const open = !folded.has(pid)
              const running = ts.filter((t) => t.status === 'running').length
              // 收起「更多」时也要露出正在看的那个任务
              const shown = more.has(pid)
                ? ts
                : ts.filter((t, i) => i < PER_PROJECT || (route.page === 'projects' && route.sub === t.id))
              const onProject = route.page === 'projects' && route.id === pid && !route.sub
              const p = projects.find((x) => x.id === pid)!
              return (
                <section key={pid} className="mb-2">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div
                        className={cn(
                          'group/proj flex h-8 items-center gap-1 rounded-lg pr-1 pl-1 text-[12.5px] transition-colors',
                          onProject ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/60',
                        )}
                      >
                        <button
                          onClick={() => toggleFolded(pid)}
                          aria-expanded={open}
                          aria-label={open ? t('收起') : t('展开')}
                          disabled={!ts.length}
                          className={cn(
                            'grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:text-fg',
                            !ts.length && 'invisible',
                          )}
                        >
                          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                        </button>
                        {renaming === pid ? (
                          <input
                            autoFocus
                            defaultValue={p.name}
                            aria-label={t('项目名称')}
                            onFocus={(e) => e.target.select()}
                            onBlur={(e) => rename(p, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur()
                              if (e.key === 'Escape') {
                                e.stopPropagation()
                                setRenaming('')
                              }
                            }}
                            className="h-6 min-w-0 flex-1 rounded-md border border-accent bg-field px-1.5 text-[12.5px] font-medium text-fg outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => go({ page: 'projects', id: pid })}
                            title={t('打开项目「{name}」，右键查看更多操作', { name: projectName(pid) })}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                          >
                            {open ? (
                              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" />
                            ) : (
                              <Folder className="h-3.5 w-3.5 shrink-0 text-subtle" />
                            )}
                            <span className="min-w-0 flex-1 truncate font-medium">{projectName(pid)}</span>
                          </button>
                        )}
                        {!open && ts.some((t) => t.requests?.length) && (
                          <BellRing aria-label={t('有对话需要你处理')} className="h-3.5 w-3.5 shrink-0 text-warning" />
                        )}
                        {running > 0 ? (
                          <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-[10.5px] leading-[18px] font-medium text-accent group-hover/proj:hidden">
                            {t('{n} 个执行中', { n: running })}
                          </span>
                        ) : (
                          ts.length > 0 && (
                            <span className="shrink-0 pr-1 text-[11px] text-subtle tabular-nums group-hover/proj:hidden">
                              {ts.length}
                            </span>
                          )
                        )}
                        <button
                          onClick={() => go({ page: 'projects', id: pid })}
                          aria-label={t('在「{name}」新建对话', { name: projectName(pid) })}
                          title={t('新建对话')}
                          // 还没有对话的项目一直显示 +，有对话的鼠标移上去才显示
                          className={cn(
                            ts.length ? 'hidden' : 'grid opacity-60',
                            'h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle group-hover/proj:grid group-hover/proj:opacity-100 hover:bg-sel hover:text-fg',
                          )}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => go({ page: 'projects', id: pid })}>
                        <MessageSquarePlus className="h-4 w-4" />
                        {t('新建对话')}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => openProject(pid)}>
                        <Settings2 className="h-4 w-4" />
                        {t('项目设置')}
                      </ContextMenuItem>
                      {!import.meta.env.VITE_DEMO && (
                        <ContextMenuItem disabled={!p.path} onSelect={() => reveal(p)}>
                          <FolderSearch className="h-4 w-4" />
                          {t('在文件夹中打开')}
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onSelect={() => setRenaming(pid)}>
                        <PencilLine className="h-4 w-4" />
                        {t('重命名')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem danger onSelect={() => setDeleting(p)}>
                        <Trash2 className="h-4 w-4" />
                        {t('删除')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {open && ts.length > 0 && (
                    <div className="mt-0.5 ml-[18px] flex flex-col gap-px border-l pl-1.5">
                      {shown.map((t) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          active={route.page === 'projects' && route.sub === t.id}
                          onOpen={() => go({ page: 'projects', id: t.projectId, sub: t.id })}
                          onDeleted={() =>
                            route.page === 'projects' && route.sub === t.id && go({ page: 'projects', id: pid })
                          }
                          className="px-2"
                        />
                      ))}
                      {ts.length > PER_PROJECT && (
                        <button
                          onClick={() =>
                            setMore((prev) => {
                              const next = new Set(prev)
                              if (!next.delete(pid)) next.add(pid)
                              return next
                            })
                          }
                          className="h-7 cursor-pointer rounded-lg px-2 text-left text-xs text-subtle hover:bg-sel/70 hover:text-fg"
                        >
                          {more.has(pid) ? t('收起') : t('显示全部 {n} 个', { n: ts.length })}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )
            })}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className={cn('flex shrink-0 items-center gap-1 border-t px-2 py-2', narrow && 'flex-col')}>
        <Row
          icon={Settings}
          label={t('设置')}
          collapsed={narrow}
          badge={update ? t('有新版本') : undefined}
          onClick={() => {
            setMobileOpen(false)
            openSettings(update ? 'update' : undefined)
          }}
          className={cn(!narrow && 'flex-1')}
        />
        <button
          onClick={onToggleTheme}
          aria-label={dark ? t('切换到浅色') : t('切换到深色')}
          title={dark ? t('切换到浅色') : t('切换到深色')}
          className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel hover:text-fg"
        >
          {dark ? (
            <Sun className="h-[18px] w-[18px]" strokeWidth={1.7} />
          ) : (
            <Moon className="h-[18px] w-[18px]" strokeWidth={1.7} />
          )}
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* 手机：顶部条 + 抽屉 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-rail px-3 md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label={t('打开菜单')}
          className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-muted hover:bg-sel"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
        <Logo />
        <span className="font-serif text-[15px] font-semibold">{t('Agent 面板')}</span>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t('菜单')}
            className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col bg-rail shadow-pop"
          >
            <button
              autoFocus
              onClick={() => setMobileOpen(false)}
              aria-label={t('关闭菜单')}
              className="absolute top-3 right-3 z-10 grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel"
            >
              <X className="h-4 w-4" />
            </button>
            {body(false)}
          </aside>
        </div>
      )}
      <aside
        aria-label={t('侧栏')}
        className={cn(
          'hidden shrink-0 flex-col border-r bg-rail transition-[width] duration-200 md:flex',
          collapsed ? 'w-[56px]' : 'w-[264px]',
        )}
      >
        {body(collapsed)}
      </aside>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={t('删除「{name}」？', { name: deleting?.name ?? '' })}
        description={t('会删除面板里的配置和这个项目的所有对话，不会动本地目录里的文件。')}
        onConfirm={() => deleting && remove(deleting)}
      />
    </>
  )
}
