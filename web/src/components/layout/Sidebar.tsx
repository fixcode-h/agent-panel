import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import {
  Archive,
  CircleAlert,
  Code2,
  MessagesSquare,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
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
  Palette,
  Plus,
  Settings,
  Sun,
  X,
  GripVertical,
  type LucideIcon,
} from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { useData, useNav, type PageId, type Route } from '@/lib/data'
import { cn } from '@/lib/utils'
import { useAppUpdate } from '@/lib/app-update'
import { deployedUpdateHint, sharedUpdateHint, useSkillUpdates } from '@/lib/skill-updates'
import { rowTip } from '@/lib/sidebar-hint'
import { useTaskSearch } from '@/lib/use-task-search'
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
import { IconButton } from '@/components/ui/icon-button'
import { InlineRename } from '@/components/ui/inline-rename'
import { Sheet } from '@/components/ui/sheet'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Kbd } from '@/components/ui/kbd'
import {
  NAV_ROW,
  SidebarModeTabs,
  SidebarProjectName,
  SidebarProjectRow,
  SidebarTaskBlock,
} from '@/components/ui/sidebar'
import { isMac } from '@/lib/hotkey'
import { ResizeHandle, contentPaneWidth, usePaneWidth } from '@/components/ui/resize'
import { TOGGLE_SIDEBAR } from './CommandPalette'
import { unmergedOf } from '@/components/tasks/Worktrees'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import {
  ChatList,
  ContentHits,
  SIDEBAR_CONTENT_HITS,
  SIDEBAR_GROUP_LABEL,
  SIDEBAR_ROW_OFF,
  SIDEBAR_ROW_ON,
  TaskRow,
  TaskSearch,
  matchTask,
  type TaskFilter,
} from './SidebarTasks'
import { DesignList } from './SidebarDesigns'
import {
  ComfyIcon,
  McpIcon,
  OverviewIcon,
  RoleIcon,
  ScheduleIcon,
  SkillIcon,
  SummaryIcon,
  WorkflowIcon,
  type NavIcon,
} from './rail-icons'
import { isTaskUnread, useUnreadTasks } from '@/lib/task-unread'
import { TRASH_RETENTION_DAYS, byAskedAt, taskBusy, taskBusyCount } from '@shared/task'
import { moveItem, useDragSort } from '@/lib/useDragSort'
import { sortProjects } from '@shared/project-order'

/** 产品图标：陶土橙渐变圆角方块（--logo-bg，品牌色不跟配色变）+ 白色节点图，顶上一道高光、底下一点投影浮起来 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      style={{ background: 'var(--logo-bg)' }}
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white',
        'shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_1px_2px_rgb(0_0_0/0.18)]',
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-[18px] w-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="5" r="2.2" />
        <circle cx="5.5" cy="18" r="2.2" />
        <circle cx="18.5" cy="18" r="2.2" />
        <path d="M10.9 7l-4.3 9M13.1 7l4.3 9M7.8 18h8.4" />
        <circle cx="12" cy="13.3" r="1.3" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

/**
 * 功能页：宽屏时放在最左边的图标栏（ActivityBar）里，打开时不显示会话侧栏、图标栏顶上换成「回到主页」；
 * 手机的抽屉菜单里照旧列在会话侧栏里
 */
export const NAV: { id: PageId; label: string; icon: NavIcon }[] = [
  { id: 'overview', label: t('对话总览'), icon: OverviewIcon },
  { id: 'summary', label: t('工作总结'), icon: SummaryIcon },
  { id: 'schedules', label: t('计划'), icon: ScheduleIcon },
  { id: 'agents', label: t('角色'), icon: RoleIcon },
  { id: 'workflows', label: t('工作流'), icon: WorkflowIcon },
  { id: 'library', label: t('Skills'), icon: SkillIcon },
  { id: 'mcp', label: t('MCP 工具'), icon: McpIcon },
]

/**
 * 只属于设计模式的功能页：宽屏时也在图标栏里，但只在设计模式（设计页、ComfyUI 页）下出现；
 * 打开时和其它功能页一样让开会话侧栏（ComfyUI 页自己有工作流列表）
 */
export const DESIGN_NAV: { id: PageId; label: string; icon: NavIcon }[] = [
  { id: 'comfy', label: t('ComfyUI 工作流'), icon: ComfyIcon },
]

/** 侧栏任务的更新时间：今天显示时刻，其余显示几天前或日期 */
const PER_PROJECT = 5

/** 新建任务的快捷键（见 CommandPalette：浏览器不让网页占 Ctrl+N），行尾悬停时提示 */
const NEW_TASK_KEY = isMac ? '⌘⇧O' : 'Ctrl+Shift+O'

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

/**
 * 会话侧栏收没收起：图标栏顶上的按钮、⌘B、命令面板都改它，侧栏和图标栏读同一份（记在本机）
 */
let collapsedNow = (() => {
  try {
    return localStorage.getItem('sidebar') === 'collapsed'
  } catch {
    return false
  }
})()
const collapsedSubs = new Set<() => void>()
export function toggleSidebar() {
  collapsedNow = !collapsedNow
  try {
    localStorage.setItem('sidebar', collapsedNow ? 'collapsed' : 'open')
  } catch {}
  for (const f of collapsedSubs) f()
}
export function useSidebarCollapsed() {
  return useSyncExternalStore(
    (cb) => {
      collapsedSubs.add(cb)
      return () => void collapsedSubs.delete(cb)
    },
    () => collapsedNow,
  )
}

function useCollapsed() {
  const v = useSidebarCollapsed()
  // ⌘B 和命令面板发来的切换（侧栏只挂一份，监听也只有一份）
  useEffect(() => {
    window.addEventListener(TOGGLE_SIDEBAR, toggleSidebar)
    return () => window.removeEventListener(TOGGLE_SIDEBAR, toggleSidebar)
  }, [])
  return v
}

function Row({
  icon: Icon,
  label,
  on,
  onClick,
  collapsed,
  className,
  badge,
  dot,
  kbd,
}: {
  icon: LucideIcon | NavIcon
  label: string
  on?: boolean
  onClick: () => void
  collapsed: boolean
  className?: string
  /** 右上角的提示点，例如有新版本 */
  badge?: string
  /** 圆点的提示（例如部署内容有差异），文字放在悬停提示和无障碍标签里 */
  dot?: string
  /** 行尾的快捷键提示：悬停才露出，不算进按钮的可访问名称 */
  kbd?: string
}) {
  // 收起时文字都不显示，悬停提示要把名字和两条提示都带上；展开时 chip 自己带文字，只把圆点的说明放进去
  const tip = rowTip(label, dot, badge)
  // 提示挂在按钮的 aria-describedby 上：直接放进按钮里会被算进可访问名称，按名字找「设置」的定位和读屏都受影响
  const hintId = useId()
  return (
    <>
      <button
        onClick={onClick}
        aria-current={on ? 'page' : undefined}
        aria-describedby={dot ? hintId : undefined}
        title={collapsed ? tip || undefined : dot}
        className={cn(
          'group/nav',
          NAV_ROW,
          on ? SIDEBAR_ROW_ON : SIDEBAR_ROW_OFF,
          on && 'font-medium',
          collapsed && 'justify-center px-0',
          className,
        )}
      >
        <span className="relative shrink-0">
          <Icon className="h-4 w-4" strokeWidth={2.2} />
          {(badge || dot) && collapsed && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-rail"
            />
          )}
        </span>
        {!collapsed && <span className="truncate">{label}</span>}
        {/* 圆点和 chip 可以同时有：圆点在左、chip 在右，两条提示都不吃 */}
        {dot && !collapsed && (
          <span
            aria-hidden="true"
            title={dot}
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-accent', !badge && 'ml-auto')}
          />
        )}
        {badge && !collapsed && (
          <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[0.6875rem] text-accent-text">
            {badge}
          </span>
        )}
        {kbd && !collapsed && (
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover/nav:opacity-100">
            <span aria-hidden>{kbd}</span>
          </Kbd>
        )}
      </button>
      {dot && (
        <span id={hintId} className="sr-only">
          {dot}
        </span>
      )}
    </>
  )
}

/** 切到各模式时回到上次在那个模式里看的页面 */
let lastChatRoute: Route = { page: 'chat' }
let lastAgentRoute: Route = { page: 'home' }
let lastDesignRoute: Route = { page: 'design' }
/** 最近一次看的会话页（任务、项目、聊天、设计）：功能页上「回到主页」回到这里 */
let lastWorkRoute: Route = { page: 'home' }
/** 最近看的设计页（不含 ComfyUI 页）：ComfyUI 页上「回到主页」回到设计里，不跳回 Agent 模式 */
let lastDesignHome: Route = { page: 'design' }
export const homeRoute = (from?: PageId) =>
  from && DESIGN_NAV.some((n) => n.id === from) ? lastDesignHome : lastWorkRoute
/** 功能页：会话侧栏让开，整页给这个功能 */
export const isToolPage = (page: PageId) => NAV.some((n) => n.id === page) || DESIGN_NAV.some((n) => n.id === page)
/** 设计模式：设计页和它的 ComfyUI 工作流页 */
export const isDesignPage = (page: PageId) => page === 'design' || page === 'comfy' || page === 'model'

/**
 * 顶部的模式切换，参考 Claude 应用：Agent 是按项目执行任务，Chat 是不属于项目的聊天，设计是按项目做界面。
 * 展开时是侧栏左上角一组小图标按钮（照 Claude 桌面版）；会话侧栏让开时（功能页、收起）竖着排在图标栏里。
 * 功能页不属于哪个模式：三个都不亮，点哪个都回到那个模式最近的页面
 */
export function ModeSwitch({ narrow }: { narrow: boolean }) {
  const { route, go } = useNav()
  const tool = isToolPage(route.page)
  const chat = route.page === 'chat'
  // ComfyUI 工作流管理属于 UI 设计
  const design = isDesignPage(route.page)
  const modes = [
    {
      id: 'agent',
      name: 'Agent',
      label: t('Agent 模式：在项目里执行任务和工作流'),
      icon: Code2,
      on: !chat && !design && !tool,
      to: lastAgentRoute,
    },
    {
      id: 'chat',
      name: 'Chat',
      label: t('Chat 模式：直接聊天，不用选项目'),
      icon: MessagesSquare,
      on: chat,
      to: lastChatRoute,
    },
    {
      id: 'design',
      name: t('设计'),
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
            // 选中用 seg-thumb：深色下 bg-sel 贴着侧栏底色几乎看不出来；未选中用 muted，subtle 在深色下像禁用
            className={cn(
              'press grid h-9 w-9 cursor-pointer place-items-center rounded-[10px]',
              m.on ? 'seg-thumb' : 'text-subtle hover:bg-hover hover:text-fg',
            )}
          >
            {/* 和图标栏的导航图标同一套线宽，小一号：模式是次一级的切换 */}
            <m.icon className="h-5 w-5" strokeWidth={1.75} />
          </button>
        ))}
      </div>
    )
  }
  return (
    <SidebarModeTabs
      modes={modes}
      onPick={(id) => {
        const m = modes.find((x) => x.id === id)
        if (m) go(m.to)
      }}
    />
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
  // 「自带 Skill」那份有新内容时在「Skills」上亮点；部署的那份归「设置 → 部署」，不在这里算
  const skillUpd = useSkillUpdates()
  const skillDot = sharedUpdateHint(skillUpd)
  // 「设置 → 部署」那份和这一版不同时，「设置」入口本身也要带点：用户在任务页看不到设置内部
  const deployDot = deployedUpdateHint(skillUpd)
  const collapsed = useCollapsed()
  // 侧栏可以拖宽，但中间要留出内容宽度（输入框的宽度），右边有任务面板时也要算进去；除此之外不设上限
  const pane = usePaneWidth('sidebar', 264, 200, () => {
    const panel = document.querySelector('[data-task-panel]')?.getBoundingClientRect().width ?? 0
    // 窗口不够宽时上限不会把侧栏压得比默认还窄，只是不允许再拖宽
    return Math.max(264, window.innerWidth - panel - contentPaneWidth() - 48)
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => setMobileOpen(false), [route])
  const chatMode = route.page === 'chat'
  const designMode = isDesignPage(route.page)
  // ComfyUI 工作流管理也算 UI 设计：不能记成 Agent 模式的页面，否则点 Agent 又回到 ComfyUI，切不过去
  // 功能页不记：从功能页切模式、回主页都回到最近的会话页，不是又回到功能页
  if (designMode) lastDesignRoute = route
  else if (chatMode) lastChatRoute = route
  else if (!isToolPage(route.page)) lastAgentRoute = route
  if (!isToolPage(route.page)) lastWorkRoute = route
  if (route.page === 'design') lastDesignHome = route

  // 按项目分组：项目分组只按添加时间（或拖拽后的顺序）排，不受任务时间、执行状态影响；组内任务仍按最近发言排
  const [folded, toggleFolded, setFolded] = useFolded()
  const [more, setMore] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const filtering = !!query.trim() || filter !== 'all'
  // 正文搜索：标题命中在 found 里（本地筛），正文命中走服务端，排在标题命中后面。
  // Chat 模式的侧栏是 ChatList、设计模式的侧栏是 DesignList，都不显示任务命中：这里传空串（= 不搜），
  // 免得同一次输入发两份请求或者为看不见的结果白扫一遍对话
  const content = useTaskSearch(chatMode || designMode ? '' : query)
  // 子对话只在父对话页的「子对话」一栏里看，不占项目下的任务列表
  // 模型设计对话属于设计模式（#/model），不列进 Agent 模式的项目对话
  const projectTasks = tasks.filter((t) => t.projectId && !t.parentTaskId && !t.modelDesign)
  const found = filtering ? projectTasks.filter((t) => matchTask(t, query, filter)).sort(byAskedAt) : []
  // 只留项目里的对话：侧栏这一栏不列 Chat，正文命中也不该混进来
  const contentHits = content.hits.filter((h) => projectTasks.some((x) => x.id === h.taskId))
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
  const idleTasks = (pid: string) => recent.filter((x) => x.projectId === pid && !taskBusy(x))
  const runBulk = async () => {
    if (!bulk) return
    const { project, action } = bulk
    // 确认框开着时可能有对话开始执行了：按确认那一刻的状态重新挑一遍
    const list = idleTasks(project.id)
    let ok = 0
    let failed = 0
    let kept = 0
    for (const tk of list) {
      try {
        if (action === 'delete') {
          // 有没合并的独立分支的对话不在一键清理里删，免得改动悄悄丢掉；要删就单独删，会先警告
          const wts = await api.taskWorktrees(tk.id).catch(() => ({ items: [] }))
          if (unmergedOf(wts.items).length) {
            kept++
            continue
          }
          await api.deleteTask(tk.id)
          removeTask(tk.id)
        } else upsertTask(await api.archiveTaskSummary(tk.id, true))
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
    else if (action === 'delete' && kept)
      toast.success(t('已删除 {n} 个对话，{kept} 个有没合并的独立分支，留着没删', { n: ok, kept }))
    else if (action === 'delete') toast.success(t('已删除 {n} 个对话', { n: ok }))
    else toast.success(t('已归档 {n} 个对话，可以在筛选里选「已归档」找到', { n: ok }))
  }
  const reveal = (p: Project) => {
    if (!p.path) return toast.error(t('这个项目还没有选择本地目录'))
    // 成功也给一句：资源管理器可能开在浏览器后面，没有反馈时用户只能看到「点了没反应」
    api
      .revealProject(p.id)
      .then((r) => toast.success(t('已在文件夹中打开：{dir}', { dir: r.dir })))
      .catch((e) => toast.error((e as Error).message))
  }

  /**
   * 侧栏的内容。mobile 是手机抽屉：功能页入口和设置都在这里；宽屏时它们在最左边的图标栏（ActivityBar），
   * 侧栏只放会话（新建、项目和对话），收起侧栏的按钮也在图标栏顶上
   */
  const body = (narrow: boolean, mobile = false) => (
    <>
      {/* 左上角：模式切换（一组小图标按钮，靠左，不放 logo） */}
      <div className={cn('flex h-14 shrink-0 items-center pt-1 pr-3 pb-1.5 pl-2.5', narrow && 'justify-center px-0')}>
        {!narrow && <ModeSwitch narrow={false} />}
      </div>

      <nav aria-label={t('主导航')} className={cn('flex flex-col gap-0.5 px-2.5', narrow && 'items-center px-2')}>
        {narrow && <ModeSwitch narrow />}
        {designMode ? (
          <>
            <Row
              icon={Plus}
              label={t('新建设计')}
              collapsed={narrow}
              on={route.page === 'design' && (!route.id || route.id === 'new')}
              onClick={() => go({ page: 'design' })}
            />
            {/* 宽屏时 ComfyUI 入口在图标栏里，手机抽屉里照旧列在这 */}
            {mobile &&
              DESIGN_NAV.map((n) => (
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
        ) : chatMode ? (
          <Row
            icon={Plus}
            label={t('新建聊天')}
            collapsed={narrow}
            on={!route.id}
            onClick={() => go({ page: 'chat' })}
          />
        ) : (
          <>
            <Row
              icon={Plus}
              label={t('新建任务')}
              collapsed={narrow}
              on={route.page === 'home'}
              onClick={() => go({ page: 'home' })}
              kbd={NEW_TASK_KEY}
              // 设计稿：「新建任务」是主入口，前景色 + 600，其余导航是次要色 + 500
              className="font-semibold text-fg"
            />
            {mobile &&
              NAV.map((n) => (
                <Row
                  key={n.id}
                  icon={n.icon}
                  label={n.label}
                  collapsed={narrow}
                  on={route.page === n.id}
                  onClick={() => go({ page: n.id })}
                  dot={n.id === 'library' ? skillDot : undefined}
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
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2">
          <TaskSearch
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            placeholder={t('搜索任务')}
          />
          <p className={cn('flex h-7 shrink-0 items-center px-2.5', SIDEBAR_GROUP_LABEL)}>
            {/* 计数和下面实际列出来的行一致：标题命中 + 这一侧栏能显示的正文命中（只算项目里的对话） */}
            {t('找到 {n} 个', { n: found.length + Math.min(contentHits.length, SIDEBAR_CONTENT_HITS) })}
          </p>
          {found.length === 0 && !contentHits.length && (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <FolderSearch className="h-5 w-5 text-subtle" strokeWidth={2} />
              <p className="text-xs leading-relaxed text-subtle">{t('没有符合的任务。')}</p>
            </div>
          )}
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
          <ContentHits
            hits={contentHits}
            loading={content.loading}
            onOpen={(h) => {
              const tk = projectTasks.find((x) => x.id === h.taskId)
              if (tk) go({ page: 'projects', id: tk.projectId, sub: tk.id, msg: h.messageId })
            }}
          />
        </div>
      ) : !narrow ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2">
          <TaskSearch
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={setFilter}
            placeholder={t('搜索任务')}
          />
          <div className="group/head mt-1 mb-1.5 flex h-6 shrink-0 items-center gap-0.5 pr-1 pl-2">
            <button
              onClick={() => toggleFolded(ALL)}
              aria-expanded={allOpen}
              className={cn(
                'flex cursor-pointer items-center gap-1 transition-colors hover:text-fg',
                SIDEBAR_GROUP_LABEL,
                'font-semibold tracking-[0.08em]',
              )}
            >
              {t('项目')}
              <ChevronDown className={cn('h-3 w-3 transition-transform', !allOpen && '-rotate-90')} />
            </button>
            <Menu>
              <MenuTrigger asChild>
                <IconButton icon={MoreHorizontal} label={t('项目菜单')} title={t('更多')} className="ml-auto" />
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
            <IconButton icon={Plus} label={t('新建项目')} onClick={() => openProject()} />
          </div>
          {allOpen && projects.length === 0 && (
            <EmptyPanel as="div" size="md" className="mx-0.5 mt-1 flex flex-col items-center gap-2">
              <FolderPlus className="h-5 w-5 text-subtle" strokeWidth={2} />
              <p className="text-xs leading-relaxed text-subtle">
                {t('还没有项目。点右边的 + 添加一个本机目录，再在项目里新建对话。')}
              </p>
            </EmptyPanel>
          )}
          {allOpen &&
            groups.map(([pid, ts], gi) => {
              const open = !folded.has(pid)
              const running = taskBusyCount(ts)
              // 收起「更多」时也要露出正在看的那个任务
              const shown = more.has(pid)
                ? ts
                : ts.filter((t, i) => i < PER_PROJECT || (route.page === 'projects' && route.sub === t.id))
              // 正在看这个项目（首页或里面的某个对话）时项目行是淡蓝底，照设计稿：选中对话的白卡片挂在蓝底项目下面
              const onProject = route.page === 'projects' && route.id === pid
              const p = projects.find((x) => x.id === pid)!
              const dragging = sort.drag === gi
              // 拖拽只从手柄开始，分组本身只当放置目标：点展开、打开、右键都不会误触拖拽
              const handle = sort.itemProps(gi, groups.length)
              return (
                <section
                  key={pid}
                  onDragOver={handle.onDragOver}
                  onDrop={handle.onDrop}
                  className={cn('relative mb-1 rounded-lg', dragging && 'opacity-40')}
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
                      <SidebarProjectRow
                        open={open}
                        on={onProject}
                        canToggle={ts.length > 0}
                        onToggle={() => toggleFolded(pid)}
                        running={running}
                        count={ts.length}
                        name={
                          renaming === pid ? (
                            <InlineRename
                              value={p.name}
                              label={t('项目名称')}
                              size="sm"
                              onCommit={(v) => rename(p, v)}
                              onCancel={() => setRenaming('')}
                              className="flex-1"
                            />
                          ) : (
                            <button
                              onClick={() => go({ page: 'projects', id: pid })}
                              title={t('打开项目「{name}」，右键查看更多操作', { name: projectName(pid) })}
                              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                            >
                              <SidebarProjectName open={open} on={onProject} name={projectName(pid)} />
                            </button>
                          )
                        }
                        alert={
                          !open &&
                          ts.some((t) => t.requests?.length) && (
                            <CircleAlert
                              aria-label={t('有对话需要你处理')}
                              className="h-3.5 w-3.5 shrink-0 text-warning"
                              strokeWidth={2.4}
                            />
                          )
                        }
                        actions={
                          <>
                            <span
                              {...handle}
                              tabIndex={0}
                              role="button"
                              aria-label={t('拖动调整「{name}」的顺序', { name: projectName(pid) })}
                              title={t('拖动调整顺序（也可以按 Alt + ↑ / ↓）')}
                              // 手柄只负责拖拽，按下不会展开或打开项目，右键也不弹项目菜单。
                              // 不悬停时宽度收成 0：隐藏的手柄还占着位置的话，行尾的「N 个执行中」会离右边空出一截
                              onClick={(e) => e.preventDefault()}
                              onContextMenu={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') e.preventDefault()
                                handle.onKeyDown(e)
                              }}
                              className="grid h-6 w-0 shrink-0 cursor-grab place-items-center overflow-hidden rounded text-subtle opacity-0 group-hover/proj:w-4 group-hover/proj:opacity-60 hover:opacity-100 focus-visible:w-4 focus-visible:opacity-100 focus-visible:outline-none active:cursor-grabbing"
                            >
                              <GripVertical className="h-3.5 w-3.5" />
                            </span>
                            <IconButton
                              icon={Plus}
                              onClick={() => go({ page: 'projects', id: pid })}
                              label={t('在「{name}」新建对话', { name: projectName(pid) })}
                              title={t('新建对话')}
                              // 还没有对话的项目一直显示 +，有对话的鼠标移上去才显示
                              className={cn(
                                ts.length ? 'hidden' : 'opacity-60',
                                'group-hover/proj:grid group-hover/proj:opacity-100',
                              )}
                            />
                          </>
                        }
                      />
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
                    <SidebarTaskBlock>
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
                          inBlock
                          className="pr-2 pl-2"
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
                          className="ml-1 h-7 cursor-pointer rounded-lg px-[11px] text-left text-xs text-subtle transition-colors hover:bg-sel hover:text-fg"
                        >
                          {more.has(pid) ? t('收起') : t('显示全部 {n} 个', { n: ts.length })}
                        </button>
                      )}
                    </SidebarTaskBlock>
                  )}
                </section>
              )
            })}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {mobile && (
        <div className={cn('flex shrink-0 items-center gap-1 px-2.5 py-2', narrow && 'flex-col px-2')}>
          <Row
            icon={Settings}
            label={t('设置')}
            collapsed={narrow}
            badge={update ? t('有新版本') : undefined}
            dot={deployDot}
            onClick={() => {
              setMobileOpen(false)
              openSettings(update ? 'update' : undefined)
            }}
            className={cn(!narrow && 'flex-1')}
          />
          <IconButton
            onClick={onToggleTheme}
            icon={dark ? Sun : Moon}
            label={dark ? t('切换到浅色') : t('切换到深色')}
            size="sm"
            strokeWidth={2.1}
          />
        </div>
      )}
    </>
  )

  return (
    <>
      {/* 手机：顶部条 + 抽屉 */}
      <div className="flex h-12 shrink-0 items-center gap-2 bg-rail px-3 md:hidden">
        <IconButton icon={MenuIcon} label={t('打开菜单')} size="sm" onClick={() => setMobileOpen(true)} />
        <Logo />
        <span className="font-serif text-[0.9375rem] font-semibold">{t('Agent 面板')}</span>
      </div>
      {/* 抽屉只在手机宽度用：窗口拉宽时侧栏本身就出来了，抽屉跟着藏起来 */}
      <Sheet
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        title={t('菜单')}
        side="left"
        width="min(280px, 85vw)"
        bare
        className="bg-rail md:hidden"
      >
        <IconButton
          autoFocus
          icon={X}
          label={t('关闭菜单')}
          size="sm"
          onClick={() => setMobileOpen(false)}
          className="absolute top-3 right-3 z-10"
        />
        {body(false, true)}
      </Sheet>
      {/* 宽屏：收起时整栏让开（图标栏还在），功能页（计划、工作流……）也让开，整页给那个功能 */}
      {!collapsed && !isToolPage(route.page) && (
        <aside
          aria-label={t('侧栏')}
          data-sidebar
          style={{ width: pane.width }}
          className="relative hidden shrink-0 flex-col bg-rail md:flex"
        >
          {body(false)}
          <ResizeHandle pane={pane} side="right" label={t('拖动调整侧栏的宽度')} />
        </aside>
      )}
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
            ? t(
                '正在执行的对话、有没合并的独立分支的对话不受影响。删除的对话会移进回收站，{days} 天内可以在设置 →「数据」→ 回收站里恢复，不会动本地目录里的文件。',
                { days: TRASH_RETENTION_DAYS },
              )
            : t('正在执行的对话不受影响。归档的对话不会删除，可以在筛选里选「已归档」找到。')
        }
        confirmText={bulk?.action === 'delete' ? t('删除') : t('归档')}
        onConfirm={runBulk}
      />
    </>
  )
}
