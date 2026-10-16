import { useState } from 'react'
import { Toaster } from 'sonner'
import { DataProvider, NavCtx, type Route } from '@/lib/data'
import { AgentsPage } from '@/pages/AgentsPage'
import { WorkflowsPage } from '@/pages/WorkflowsPage'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { HomePage } from '@/pages/HomePage'
import { SettingsDialog } from '@/pages/SettingsPage'
import { DemoBanner } from '@/components/layout/DemoBanner'
import { Sidebar } from '@/components/layout/Sidebar'

/** 页面登记；新增页面在这里加一项，并在 Sidebar 的 NAV 里加入口 */
const PAGES: Record<Route['page'], () => React.ReactNode> = {
  home: () => <HomePage />,
  projects: () => <ProjectsPage />,
  agents: () => <AgentsPage />,
  workflows: () => <WorkflowsPage />,
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

export function App() {
  const [route, setRoute] = useState<Route>({ page: 'home' })
  const [settings, setSettings] = useState<{ open: boolean; section?: string }>({ open: false })
  const [dark, toggleTheme] = useTheme()

  return (
    <DataProvider>
      <NavCtx.Provider value={{ route, go: setRoute, openSettings: (section) => setSettings({ open: true, section }) }}>
        <div className="flex min-h-full flex-col md:h-full">
          {import.meta.env.VITE_DEMO && <DemoBanner />}
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <Sidebar dark={dark} onToggleTheme={toggleTheme} />
            <div className="flex min-w-0 flex-1 flex-col md:flex-row md:overflow-hidden">{PAGES[route.page]()}</div>
          </div>
        </div>
        <SettingsDialog
          open={settings.open}
          section={settings.section}
          onOpenChange={(open) => setSettings((s) => ({ ...s, open }))}
        />
        <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" />
      </NavCtx.Provider>
    </DataProvider>
  )
}
