import { useEffect, useState } from 'react'
import { useEscape } from '@/lib/useEscape'
import {
  Archive,
  CircleAlert,
  Bot,
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
  Palette,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Sun,
  Workflow,
  X,
  GripVertical,
  type LucideIcon,
} from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { useData, useNav, type PageId, type Route } from '@/lib/data'
import { cn } from '@/lib/utils'
import { useAppUpdate } from '@/lib/app-update'
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
import { ResizeHandle, contentPaneWidth, usePaneWidth } from '@/components/ui/resize'
import { TOGGLE_SIDEBAR } from './CommandPalette'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { t } from '@shared/i18n'
import { ChatList, TaskRow, TaskSearch, matchTask, type TaskFilter } from './SidebarTasks'
import { DesignList } from './SidebarDesigns'
import { isTaskUnread, useUnreadTasks } from '@/lib/task-unread'
import { byAskedAt } from '@shared/task'
import { moveItem, useDragSort } from '@/lib/useDragSort'
import { sortProjects } from '@shared/project-order'

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
  { id: 'agents', label: t('角色'), icon: Bot },
  { id: 'workflows', label: t('工作流'), icon: Workflow },
  { id: 'library', label: t('Skills 与命令'), icon: Sparkles },
  { id: 'mcp', label: t('MCP 工具'), icon: Plug },
]

/** 侧栏任务的更新时间：今天显示时刻，其余显示几天前或日期 */
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
  const toggle = () =>
    set((cur) => {
      try {
        localStorage.setItem('sidebar', cur ? 'open' : 'collapsed')
      } catch {}
      return !cur
    })
  // ⌘B 和命令面板发来的切换
  useEffect(() => {
    window.addEventListener(TOGGLE_SIDEBAR, toggle)
    return () => window.removeEventListener(TOGGLE_SIDEBAR, toggle)
  }, [])
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
        'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[0.84375rem] transition-colors',
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
        <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[0.6875rem] text-accent">
          {badge}
        </span>
      )}
    </button>
  )
}

/** 切到各模式时回到上次在那个模式里看的页面 */
let lastChatRoute: Route = { page: 'chat' }
let lastAgentRoute: Route = { page: 'home' }
let lastDesignRoute: Route = { page: 'design' }

/**
 * 顶部的模式切换，参考 Claude 应用：Chat 是不属于项目的聊天，Agent 是按项目执行任务，UI 设计是按项目做界面。
 * 只显示图标，名字在悬停提示里；收起侧栏时竖着排。
 */
function ModeSwitch({ narrow }: { narrow: boolean }) {
  const { route, go } = useNav()
  const chat = route.page === 'chat'
  // ComfyUI 工作流管理属于 UI 设计
  const design = route.page === 'design' || route.page === 'comfy'
  const modes = [
    {
      id: 'chat',
      label: t('Chat 模式：直接聊天，不用选项目'),
      icon: MessagesSquare,
      on: chat,
      to: lastChatRoute,
    },
    {
      id: 'agent',
      label: t('Agent 模式：在项目里执行任务和工作流'),
      icon: Code2,
      on: !chat && !design,
      to: lastAgentRoute,
    },
    {
      id: 'design',
      label: t('UI 设计：用对话设计游戏界面，导出给 UE'),
      icon: Palette,
      on: design,
      to: lastDesignRoute,
    },
  ]
  if (narrow) {
    return (
      <div role="radiogroup" aria-label={t('模式')} className="mb-1 flex flex-col items-center gap-0.5">
        {modes.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={m.on}
            onClick={() => !m.on && go(m.to)}
            aria-label={m.label}
            title={m.label}
            className={cn(
              'grid h-8 w-8 cursor-pointer place-items-center rounded-lg hover:bg-sel hover:text-fg',
              m.on ? 'bg-sel text-fg' : 'text-subtle',
            )}
          >
            <m.icon className="h-[17px] w-[17px]" strokeWidth={1.8} />
          </button>
        ))}
      </div>
    )
  }
  return (
    <div
      role="radiogroup"
      aria-label={t('模式')}
      // 只显示图标（名字在悬停提示里），以后模式再多也排得下：按数量平分宽度
      className="mx-3 mb-2 flex shrink-0 gap-0.5 rounded-lg border bg-field/60 p-0.5"
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
            'grid h-8 min-w-0 flex-1 cursor-pointer place-items-center rounded-md transition-colors',
            m.on ? 'bg-card text-fg shadow-card' : 'text-subtle hover:bg-sel/60 hover:text-fg',
          )}
        >
          <m.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
        </button>
      ))}
    </div>
  )
}

/**
 * 侧栏里的一个任务（聊天）：点击打开，右键可以暂停 / 继续、重命名、删除。
 * 暂停和继续同一时间只显示能用的那个。
 */
export function Sidebar({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { route, go, openSettings, openProject } = useNav()
  const { tasks, projects, setProjects, reloadTasks, removeTask, upsertTask } = useData()
  const unread = useUnreadTasks()
  // 橙点以服务端的 turnDoneAt / turnSeenAt 为准：本地缓存只用来补刚完成、列表还没刷新的那一小段时间
  const isUnread = (tk: Task) => isTaskUnread(tk) || unread.includes(tk.id)
  // 有可以安装的新版本时在「设置」上提示（在线演示不提示）
  const appUpdate = useAppUpdate().data
  const update = !import.meta.env.VITE_DEMO && appUpdate?.packaged ? appUpdate.update : undefined
  const [collapsed, toggleCollapsed] = useCollapsed()
  // 侧栏可以拖宽，但中间要留出内容宽度（输入框的宽度），右边有任务面板时也要算进去；除此之外不设上限
  const pane = usePaneWidth('sidebar', 264, 200, () => {
    const panel = document.querySelector('[data-task-panel]')?.getBoundingClientRect().width ?? 0
    // 窗口不够宽时上限不会把侧栏压得比默认还窄，只是不允许再拖宽
    return Math.max(264, window.innerWidth - panel - contentPaneWidth() - 48)
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => setMobileOpen(false), [route])
  const chatMode = route.page === 'chat'
  const designMode = route.page === 'design' || route.page === 'comfy'
  // ComfyUI 工作流管理也算 UI 设计：不能记成 Agent 模式的页面，否则点 Agent 又回到 ComfyUI，切不过去
  if (designMode) lastDesignRoute = route
  else if (chatMode) lastChatRoute = route
  else lastAgentRoute = route
  useEscape(mobileOpen, () => setMobileOpen(false))

  // 按项目分组：项目分组只按添加时间（或拖拽后的顺序）排，不受任务时间、执行状态影响；组内任务仍按最近发言排
  const [folded, toggleFolded, setFolded] = useFolded()
  const [more, setMore] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const filtering = !!query.trim() || filter !== 'all'
  // 子对话只在父对话页的「子对话」一栏里看，不占项目下的任务列表
  const projectTasks = tasks.filter((t) => t.projectId && !t.parentTaskId)
  const found = filtering ? projectTasks.filter((t) => matchTask(t, query, filter)).sort(byAskedAt) : []
  // 归档的不在项目分组里显示
  const recent = projectTasks.filter((t) => !t.archived).sort(byAskedAt)
  const byProject = new Map<string, Task[]>()
  for (const t of recent) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t])
  // 所有项目都列出来（还没有对话的也在），顺序只看添加时间或用户拖出来的顺序
  const ordered = sortProjects(projects)
  const groups: [string, Task[]][] = ordered.map((p) => [p.id, byProject.get(p.id) ?? []])
  // 拖拽排序：立刻生效，再写回服务端；失败时换回原来的顺序并提示
  const saveOrder = async (next: Project[]) => {
    const before = projects
    setProjects(next)
    try {
      const saved = await api.orderProjects(next.map((p) => p.id))
      setProjects(saved)
    } catch (e) {
      setProjects(before)
      toast.error(t('保存项目顺序失败：{msg}', { msg: (e as Error).message }))
    }
  }
  const sort = useDragSort((from, to) => {
    const next = moveItem(ordered, from, to)
    if (next !== ordered) void saveOrder(next)
  })
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
  // 一键清理：只动这个项目下没在执行的对话（子对话在跑的父对话也算在执行，删它会连带结束子对话）
  const [bulk, setBulk] = useState<{ project: Project; action: 'archive' | 'delete'; n: number }>()
  const idleTasks = (pid: string) => recent.filter((x) => x.projectId === pid && !x.working && !x.childrenWorking)
  const runBulk = async () => {
    if (!bulk) return
    const { project, action } = bulk
    // 确认框开着时可能有对话开始执行了：按确认那一刻的状态重新挑一遍
    const list = idleTasks(project.id)
    let ok = 0
    let failed = 0
    for (const tk of list) {
      try {
        if (action === 'delete') {
          await api.deleteTask(tk.id)
          removeTask(tk.id)
        } else upsertTask(await api.archiveTask(tk.id, true))
        ok++
      } catch {
        failed++
      }
    }
    setBulk(undefined)
    // 正在看的对话被删掉了：回到项目首页
    if (action === 'delete' && route.page === 'projects' && route.sub && list.some((x) => x.id === route.sub))
      go({ page: 'projects', id: project.id })
    if (failed) toast.error(t('{ok} 个成功，{failed} 个失败', { ok, failed }))
    else if (action === 'delete') toast.success(t('已删除 {n} 个对话', { n: ok }))
    else toast.success(t('已归档 {n} 个对话，可以在筛选里选「已归档」找到', { n: ok }))
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
            <span className="truncate font-serif text-[1rem] font-semibold tracking-tight">{t('Agent 面板')}</span>
          </button>
        )}
        <button
          onClick={toggleCollapsed}
          aria-label={narrow ? t('展开侧栏') : t('收起侧栏')}
          title={narrow ? t('展开侧栏') : t('收起侧栏')}
          // 收起时和下面的图标一样居中，不能靠右
          className={cn(
            'hidden h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel hover:text-fg md:grid',
            !narrow && 'ml-auto',
          )}
        >
          {narrow ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
        </button>
      </div>
      {!narrow && <ModeSwitch narrow={false} />}

      <nav aria-label={t('主导航')} className={cn('flex flex-col gap-0.5 px-2', narrow && 'items-center')}>
        {narrow && <ModeSwitch narrow />}
        {designMode ? (
          <>
            <Row
              icon={Plus}
              label={t('新建设计')}
              collapsed={narrow}
              on={route.page === 'design' && (!route.id || route.id === 'new')}
              onClick={() => go({ page: 'design' })}
              className={cn(!narrow && '[&>svg]:rounded-full [&>svg]:bg-accent [&>svg]:p-[3px] [&>svg]:text-white')}
            />
            <Row
              icon={Workflow}
              label={t('ComfyUI 工作流')}
              collapsed={narrow}
              on={route.page === 'comfy'}
              onClick={() => go({ page: 'comfy' })}
            />
          </>
        ) : chatMode ? (
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

      {designMode ? (
        narrow ? (
          <div className="flex-1" />
        ) : (
          <DesignList />
        )
      ) : chatMode ? (
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
                unread={isUnread(tk)}
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
            groups.map(([pid, ts], gi) => {
              const open = !folded.has(pid)
              const running = ts.filter((t) => t.working).length
              // 收起「更多」时也要露出正在看的那个任务
              const shown = more.has(pid)
                ? ts
                : ts.filter((t, i) => i < PER_PROJECT || (route.page === 'projects' && route.sub === t.id))
              const onProject = route.page === 'projects' && route.id === pid && !route.sub
              const p = projects.find((x) => x.id === pid)!
              const dragging = sort.drag === gi
              // 拖拽只从手柄开始，分组本身只当放置目标：点展开、打开、右键都不会误触拖拽
              const handle = sort.itemProps(gi, groups.length)
              return (
                <section
                  key={pid}
                  onDragOver={handle.onDragOver}
                  onDrop={handle.onDrop}
                  className={cn('relative mb-2 rounded-lg', dragging && 'opacity-40')}
                >
                  {sort.drag !== null && sort.over === gi && sort.drag !== gi && (
                    <div
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent',
                        sort.drag < gi ? '-bottom-1' : '-top-1',
                      )}
                    />
                  )}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div
                        className={cn(
                          'group/proj flex h-8 items-center gap-1 rounded-lg pr-1 pl-1 text-[0.78125rem] transition-colors',
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
                            className="h-6 min-w-0 flex-1 rounded-md border border-accent bg-field px-1.5 text-[0.78125rem] font-medium text-fg outline-none"
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
                          <CircleAlert
                            aria-label={t('有对话需要你处理')}
                            className="h-3.5 w-3.5 shrink-0 text-warning"
                            strokeWidth={2.4}
                          />
                        )}
                        {running > 0 ? (
                          <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-[0.65625rem] leading-[18px] font-medium text-accent group-hover/proj:hidden">
                            {t('{n} 个执行中', { n: running })}
                          </span>
                        ) : (
                          ts.length > 0 && (
                            <span className="shrink-0 pr-1 text-[0.6875rem] text-subtle tabular-nums group-hover/proj:hidden">
                              {ts.length}
                            </span>
                          )
                        )}
                        <span
                          {...handle}
                          tabIndex={0}
                          role="button"
                          aria-label={t('拖动调整「{name}」的顺序', { name: projectName(pid) })}
                          title={t('拖动调整顺序（也可以按 Alt + ↑ / ↓）')}
                          // 手柄放在行尾，原有对齐不变；只负责拖拽，按下不会展开或打开项目，右键也不弹项目菜单
                          onClick={(e) => e.preventDefault()}
                          onContextMenu={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') e.preventDefault()
                            handle.onKeyDown(e)
                          }}
                          className="grid h-6 w-4 shrink-0 cursor-grab place-items-center rounded text-subtle opacity-0 group-hover/proj:opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none active:cursor-grabbing"
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </span>
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
                      <ContextMenuItem
                        disabled={!idleTasks(pid).length}
                        onSelect={() => setBulk({ project: p, action: 'archive', n: idleTasks(pid).length })}
                      >
                        <Archive className="h-4 w-4" />
                        {t('归档所有未运行的对话')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        danger
                        disabled={!idleTasks(pid).length}
                        onSelect={() => setBulk({ project: p, action: 'delete', n: idleTasks(pid).length })}
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('删除所有未运行的对话')}
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
                          unread={isUnread(t)}
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
        <span className="font-serif text-[0.9375rem] font-semibold">{t('Agent 面板')}</span>
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
        data-sidebar
        style={{ width: collapsed ? 56 : pane.width }}
        className={cn(
          'relative hidden shrink-0 flex-col border-r bg-rail md:flex',
          !pane.dragging && 'transition-[width] duration-200',
        )}
      >
        {body(collapsed)}
        {!collapsed && <ResizeHandle pane={pane} side="right" label={t('拖动调整侧栏的宽度')} />}
      </aside>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={t('删除「{name}」？', { name: deleting?.name ?? '' })}
        description={t('会删除面板里的配置和这个项目的所有对话，不会动本地目录里的文件。')}
        onConfirm={() => deleting && remove(deleting)}
      />
      <ConfirmDialog
        open={!!bulk}
        onOpenChange={(o) => !o && setBulk(undefined)}
        title={
          bulk?.action === 'delete'
            ? t('删除「{name}」里 {n} 个未运行的对话？', { name: bulk.project.name, n: bulk.n })
            : t('归档「{name}」里 {n} 个未运行的对话？', { name: bulk?.project.name ?? '', n: bulk?.n ?? 0 })
        }
        description={
          bulk?.action === 'delete'
            ? t('正在执行的对话不受影响。删除后对话记录和它们的子对话都找不回来，不会动本地目录里的文件。')
            : t('正在执行的对话不受影响。归档的对话不会删除，可以在筛选里选「已归档」找到。')
        }
        confirmText={bulk?.action === 'delete' ? t('删除') : t('归档')}
        onConfirm={runBulk}
      />
    </>
  )
}
