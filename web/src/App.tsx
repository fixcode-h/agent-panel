import { Suspense, lazy, useEffect, useState } from 'react'
import { usePageSignals } from '@/lib/page-signal'
import { Toaster } from 'sonner'
import { TOAST_VISIBLE_LIMIT } from '@/lib/toast-queue'
import { DataProvider, NavCtx, useData, useNav, type Route } from '@/lib/data'
import { useTaskNotifications } from '@/lib/notify'
import { useTaskDoneUnread } from '@/lib/task-unread'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { HomePage } from '@/pages/HomePage'
import { ChatPage } from '@/pages/ChatPage'
import { ProjectSettingsDialog } from '@/components/projects/ProjectSettingsDialog'
import { DemoBanner } from '@/components/layout/DemoBanner'
import { NoCliBanner } from '@/components/layout/NoCliBanner'
import { CommandPalette, useShortcuts } from '@/components/layout/CommandPalette'
import { ElementPickHost } from '@/components/chat/ElementPicker'
import { Sidebar } from '@/components/layout/Sidebar'
import { UpdateResumeDialog } from '@/components/layout/UpdateResumeDialog'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { GlobalHintHost } from '@/components/ui/hint'
import { TaskDock } from '@/components/tasks/TaskDock'
import { useAiWindow } from '@/lib/ai-window'
import { settingsReloaded, str, useUiActions } from '@/lib/ui-actions'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// 不常用、又带着大依赖（流程图画布、设置里的各种表单）的页面按需加载，首次打开更快
const AgentsPage = lazy(() => import('@/pages/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const WorkflowsPage = lazy(() => import('@/pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })))
const LibraryPage = lazy(() => import('@/pages/LibraryPage').then((m) => ({ default: m.LibraryPage })))
const SchedulesPage = lazy(() => import('@/pages/SchedulesPage').then((m) => ({ default: m.SchedulesPage })))
const McpPage = lazy(() => import('@/pages/McpPage').then((m) => ({ default: m.McpPage })))
const SummaryPage = lazy(() => import('@/pages/SummaryPage').then((m) => ({ default: m.SummaryPage })))
const DesignPage = lazy(() => import('@/pages/DesignPage').then((m) => ({ default: m.DesignPage })))
const ComfyPage = lazy(() => import('@/pages/ComfyPage').then((m) => ({ default: m.ComfyPage })))
const AiWindow = lazy(() => import('@/components/ai-window/AiWindow').then((m) => ({ default: m.AiWindow })))
const SettingsDialog = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsDialog })))

/** 页面登记；新增页面在这里加一项，并在 Sidebar 的 NAV 里加入口 */
const PAGES: Record<Route['page'], () => React.ReactNode> = {
  home: () => <HomePage />,
  schedules: () => <SchedulesPage />,
  projects: () => <ProjectsPage />,
  agents: () => <AgentsPage />,
  workflows: () => <WorkflowsPage />,
  chat: () => <ChatPage />,
  design: () => <DesignPage />,
  comfy: () => <ComfyPage />,
  library: () => <LibraryPage />,
  mcp: () => <McpPage />,
  summary: () => <SummaryPage />,
}

/** 自己分成几块面板的页面：项目工作区（项目首页 / 任务）、打开的聊天、计划（日历 + 详情两块） */
const splitPage = (r: Route) => r.page === 'projects' || (r.page === 'chat' && !!r.id) || r.page === 'schedules'

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {}
    setDark(next)
  }
  return [dark, toggle] as const
}

/** 地址栏用 hash 记录位置（#/projects/<id>/<sub>/<msg>），刷新、前进后退、复制链接都能回到同一页 */
function parseHash(): Route {
  const [page, id, sub, msg] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  return page && page in PAGES
    ? { page: page as Route['page'], id: id || undefined, sub: sub || undefined, msg: msg || undefined }
    : { page: 'home' }
}
const toHash = (r: Route) =>
  '#/' +
  [r.page, r.id, r.sub, r.msg]
    .filter(Boolean)
    .map((x) => encodeURIComponent(x!))
    .join('/')

function useHashRoute() {
  const [route, setRoute] = useState<Route>(parseHash)
  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = (r: Route) => {
    const h = toHash(r)
    if (h === location.hash) return
    // 页面自动选中第一项这类跳转不该多出一条历史记录
    const replace = r.page === route.page && !route.id
    history[replace ? 'replaceState' : 'pushState'](null, '', h)
    setRoute(r)
  }
  return [route, go] as const
}

/** 任务完成通知和标签页标题 */
function TaskWatcher() {
  const { tasks } = useData()
  const { route, go } = useNav()
  // 正在看的对话：项目里的任务或 Chat 里的聊天
  const viewing = route.page === 'projects' && route.sub ? route.sub : route.page === 'chat' ? (route.id ?? '') : ''
  useTaskDoneUnread(tasks, viewing)
  useTaskNotifications(tasks, (t) =>
    go(t.projectId ? { page: 'projects', id: t.projectId, sub: t.id } : { page: 'chat', id: t.id }),
  )
  return null
}

/**
 * 对话里的 Agent 要页面做的界面操作（服务端动作表推来的 ui 事件，见 web/src/lib/ui-actions.ts）。
 * 名字和 server/app-actions 里 pushUi / ctx.ui 用的一致；加界面操作在这里加一项
 */
function UiActions({ reopenProject }: { reopenProject: (id: string, section?: string, item?: string) => void }) {
  const { go, openSettings } = useNav()
  const { setSettings } = useData()
  useUiActions({
    navigate: (a) => {
      const page = str(a.page)
      if (page && page in PAGES) go({ page: page as Route['page'], id: str(a.id), sub: str(a.sub) })
    },
    open_settings: (a) => openSettings(str(a.section)),
    open_project: (a) => {
      const id = str(a.id)
      if (id) reopenProject(id, str(a.section), str(a.item))
    },
    reload_settings: () =>
      void api
        .settings()
        .then((fresh) => {
          setSettings(fresh)
          settingsReloaded()
        })
        .catch(() => {}),
  })
  return null
}

/** 命令面板和全局快捷键（要在导航上下文里面） */
function Shortcuts() {
  const [open, setOpen] = useState(false)
  useShortcuts(() => setOpen((o) => !o))
  return (
    <>
      <CommandPalette open={open} onOpenChange={setOpen} />
      {/* 开发者模式的抓取：快捷键 + 覆盖层（全页只一份） */}
      <ElementPickHost />
    </>
  )
}

function ProjectDialog({
  open,
  id,
  section,
  item,
  onOpenChange,
}: {
  open: boolean
  id?: string
  section?: string
  item?: string
  onOpenChange: (o: boolean) => void
}) {
  const { projects } = useData()
  const project = id ? projects.find((p) => p.id === id) : undefined
  // 要打开的项目已经不在了（例如刚被删掉），就不显示
  return (
    <ProjectSettingsDialog
      open={open && (!id || !!project)}
      project={project}
      section={section}
      item={item}
      onOpenChange={onOpenChange}
    />
  )
}

export function App() {
  const [route, setRoute] = useHashRoute()
  const [settings, setSettings] = useState<{ open: boolean; section?: string; loaded?: boolean }>({ open: false })
  const aiWindow = useAiWindow()
  const [project, setProject] = useState<{ open: boolean; id?: string; section?: string; item?: string }>({
    open: false,
  })
  const [dark, toggleTheme] = useTheme()
  // 托盘右键「设置」：切到这个页面后打开设置
  usePageSignals((view) => view === 'settings' && setSettings({ open: true, loaded: true }))

  return (
    <DataProvider>
      <NavCtx.Provider
        value={{
          route,
          go: setRoute,
          openSettings: (section) => setSettings({ open: true, section, loaded: true }),
          openProject: (id, section, item) => setProject({ open: true, id, section, item }),
        }}
      >
        <div className="flex min-h-full flex-col bg-rail md:h-full">
          {/* 全界面的悬停提示：接住所有原生 title，换成统一样式的浮层（全页只挂这一份） */}
          <GlobalHintHost />
          <TaskWatcher />
          <Shortcuts />
          <UiActions
            reopenProject={(id, section, item) => {
              // 先关再开：弹窗已经开着时也按这次要的那一栏重新打开（例如 AI 初始化要从头开始）
              setProject((s) => ({ ...s, open: false }))
              setTimeout(() => setProject({ open: true, id, section, item }), 0)
            }}
          />
          {import.meta.env.VITE_DEMO && <DemoBanner />}
          <NoCliBanner />
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <Sidebar dark={dark} onToggleTheme={toggleTheme} />
            {/* 页面区直接铺到浏览器边缘，和侧栏靠底色分开；任务页、项目页自己分成「对话 + 右栏」两块面板（split），外面不再套一块 */}
            <div className="flex min-w-0 flex-1 flex-col md:flex-row md:overflow-hidden">
              <div
                className={cn(
                  'flex min-w-0 flex-1 flex-col md:flex-row md:overflow-hidden',
                  !splitPage(route) && 'panel',
                )}
              >
                {/* 页面出错时只影响这一块，侧栏照常可用；切到别的页面自动恢复 */}
                <ErrorBoundary resetKey={toHash(route)}>
                  <Suspense fallback={null}>{PAGES[route.page]()}</Suspense>
                </ErrorBoundary>
              </div>
            </div>
          </div>
        </div>
        {/* 第一次打开设置时才加载；之后一直挂着，关闭动画照常 */}
        {settings.loaded && (
          <Suspense fallback={null}>
            <SettingsDialog
              open={settings.open}
              section={settings.section}
              onOpenChange={(open) => setSettings((s) => ({ ...s, open }))}
            />
          </Suspense>
        )}
        {/* 统一的 AI 分析窗口：第一次点「AI 处理」「AI 分析」时才加载 */}
        {aiWindow.job && (
          <Suspense fallback={null}>
            <AiWindow />
          </Suspense>
        )}
        {/* 「转成弹窗」收起来的对话：和 AI 窗口同在最外层，切走页面也还在（状态在 lib/mini-task） */}
        <TaskDock />
        <ProjectDialog {...project} onOpenChange={(open) => setProject((s) => ({ ...s, open }))} />
        {/* 上次「强制更新」打断的任务：只挂一次，启动后问要不要接着跑 */}
        <UpdateResumeDialog />
        {/* 提示统一走 web/src/lib/toast.ts（自己排队，同屏上限见 lib/toast-queue.ts 的 TOAST_VISIBLE_LIMIT）：
            位置在右上角，最新的在最上面、依次往下。
            `visibleToasts` 必须和队列上限是同一个数：sonner 自己还会按 `index + 1 <= visibleToasts`
            把超出的那条设成 `data-visible="false"`（opacity 0、不吃指针），默认值是 3，
            队列放进来的第 4 条就会被它默默藏掉；设成同一个数后两者不打架。
            `expand` 必须有：不展开时 sonner 把非最上面那条压成一条边（内容透明），
            和「依次展示下来」相反；展开后鼠标悬上去也不会再整体跳一下。
            关闭按钮通过 `closeButton` 整体开启，样式在 index.css 里改成「悬停才显示」。 */}
        <Toaster
          theme={dark ? 'dark' : 'light'}
          position="top-right"
          expand
          visibleToasts={TOAST_VISIBLE_LIMIT}
          closeButton
          toastOptions={{ closeButtonAriaLabel: t('关闭') }}
        />
      </NavCtx.Provider>
    </DataProvider>
  )
}
