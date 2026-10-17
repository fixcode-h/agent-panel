import { Suspense, lazy, useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { DataProvider, NavCtx, useData, useNav, type Route } from '@/lib/data'
import { useTaskNotifications } from '@/lib/notify'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { HomePage } from '@/pages/HomePage'
import { ChatPage } from '@/pages/ChatPage'
import { ProjectSettingsDialog } from '@/components/projects/ProjectSettingsDialog'
import { DemoBanner } from '@/components/layout/DemoBanner'
import { CommandPalette, useShortcuts } from '@/components/layout/CommandPalette'
import { Sidebar } from '@/components/layout/Sidebar'
import { ErrorBoundary } from '@/components/ui/error-boundary'

// 不常用、又带着大依赖（流程图画布、设置里的各种表单）的页面按需加载，首次打开更快
const AgentsPage = lazy(() => import('@/pages/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const WorkflowsPage = lazy(() => import('@/pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })))
const DesignPage = lazy(() => import('@/pages/DesignPage').then((m) => ({ default: m.DesignPage })))
const SettingsDialog = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsDialog })))

/** 页面登记；新增页面在这里加一项，并在 Sidebar 的 NAV 里加入口 */
const PAGES: Record<Route['page'], () => React.ReactNode> = {
  home: () => <HomePage />,
  projects: () => <ProjectsPage />,
  agents: () => <AgentsPage />,
  workflows: () => <WorkflowsPage />,
  chat: () => <ChatPage />,
  design: () => <DesignPage />,
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
  const { go } = useNav()
  useTaskNotifications(tasks, (t) =>
    go(t.projectId ? { page: 'projects', id: t.projectId, sub: t.id } : { page: 'chat', id: t.id }),
  )
  return null
}

/** 命令面板和全局快捷键（要在导航上下文里面） */
function Shortcuts() {
  const [open, setOpen] = useState(false)
  useShortcuts(() => setOpen((o) => !o))
  return <CommandPalette open={open} onOpenChange={setOpen} />
}

function ProjectDialog({ open, id, onOpenChange }: { open: boolean; id?: string; onOpenChange: (o: boolean) => void }) {
  const { projects } = useData()
  const project = id ? projects.find((p) => p.id === id) : undefined
  // 要打开的项目已经不在了（例如刚被删掉），就不显示
  return <ProjectSettingsDialog open={open && (!id || !!project)} project={project} onOpenChange={onOpenChange} />
}

export function App() {
  const [route, setRoute] = useHashRoute()
  const [settings, setSettings] = useState<{ open: boolean; section?: string; loaded?: boolean }>({ open: false })
  const [project, setProject] = useState<{ open: boolean; id?: string }>({ open: false })
  const [dark, toggleTheme] = useTheme()

  return (
    <DataProvider>
      <NavCtx.Provider
        value={{
          route,
          go: setRoute,
          openSettings: (section) => setSettings({ open: true, section, loaded: true }),
          openProject: (id) => setProject({ open: true, id }),
        }}
      >
        <div className="flex min-h-full flex-col md:h-full">
          <TaskWatcher />
          <Shortcuts />
          {import.meta.env.VITE_DEMO && <DemoBanner />}
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
        <ProjectDialog {...project} onOpenChange={(open) => setProject((s) => ({ ...s, open }))} />
        <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" />
      </NavCtx.Provider>
    </DataProvider>
  )
}
