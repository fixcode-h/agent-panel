import { Suspense, lazy, useEffect, useState } from 'react'
import { usePageSignals } from '@/lib/page-signal'
import { Toaster } from 'sonner'
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
import { useAiWindow } from '@/lib/ai-window'
import { settingsReloaded, str, useUiActions } from '@/lib/ui-actions'
import { api } from '@/lib/api'

// 不常用、又带着大依赖（流程图画布、设置里的各种表单）的页面按需加载，首次打开更快
const AgentsPage = lazy(() => import('@/pages/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const WorkflowsPage = lazy(() => import('@/pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })))
const LibraryPage = lazy(() => import('@/pages/LibraryPage').then((m) => ({ default: m.LibraryPage })))
const McpPage = lazy(() => import('@/pages/McpPage').then((m) => ({ default: m.McpPage })))
const DesignPage = lazy(() => import('@/pages/DesignPage').then((m) => ({ default: m.DesignPage })))
const ComfyPage = lazy(() => import('@/pages/ComfyPage').then((m) => ({ default: m.ComfyPage })))
const AiWindow = lazy(() => import('@/components/ai-window/AiWindow').then((m) => ({ default: m.AiWindow })))
const SettingsDialog = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsDialog })))

/** 页面登记；新增页面在这里加一项，并在 Sidebar 的 NAV 里加入口 */
const PAGES: Record<Route['page'], () => React.ReactNode> = {
  home: () => <HomePage />,
  projects: () => <ProjectsPage />,
  agents: () => <AgentsPage />,
  workflows: () => <WorkflowsPage />,
  chat: () => <ChatPage />,
  design: () => <DesignPage />,
  comfy: () => <ComfyPage />,
  library: () => <LibraryPage />,
  mcp: () => <McpPage />,
}

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

/** 地址栏用 hash 记录位置（#/projects/<id>/<sub>），刷新、前进后退、复制链接都能回到同一页 */
function parseHash(): Route {
  const [page, id, sub] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  return page && page in PAGES
    ? { page: page as Route['page'], id: id || undefined, sub: sub || undefined }
    : { page: 'home' }
}
const toHash = (r: Route) =>
  '#/' +
  [r.page, r.id, r.sub]
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
        <div className="flex min-h-full flex-col md:h-full">
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
            <div className="flex min-w-0 flex-1 flex-col md:flex-row md:overflow-hidden">
              {/* 页面出错时只影响这一块，侧栏照常可用；切到别的页面自动恢复 */}
              <ErrorBoundary resetKey={toHash(route)}>
                <Suspense fallback={null}>{PAGES[route.page]()}</Suspense>
              </ErrorBoundary>
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
        <ProjectDialog {...project} onOpenChange={(open) => setProject((s) => ({ ...s, open }))} />
        {/* 上次「强制更新」打断的任务：只挂一次，启动后问要不要接着跑 */}
        <UpdateResumeDialog />
        <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" />
      </NavCtx.Provider>
    </DataProvider>
  )
}
