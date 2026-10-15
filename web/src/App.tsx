import { useState } from 'react'
import { Toaster } from 'sonner'
import { Bot, FolderKanban, Moon, Sun, Workflow, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DataProvider, NavCtx, type PageId, type Route } from '@/lib/data'
import { AgentsPage } from '@/pages/AgentsPage'
import { WorkflowsPage } from '@/pages/WorkflowsPage'

/** 左侧导航；新增页面在这里登记即可 */
const NAV: { id: PageId; label: string; icon: LucideIcon; page?: () => React.ReactNode }[] = [
  { id: 'agents', label: 'Agent', icon: Bot, page: () => <AgentsPage /> },
  { id: 'workflows', label: '工作流', icon: Workflow, page: () => <WorkflowsPage /> },
  { id: 'projects', label: '项目', icon: FolderKanban },
]

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

function Logo() {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-accent text-white">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="5.5" r="2.5" />
        <circle cx="5.5" cy="18" r="2.5" />
        <circle cx="18.5" cy="18" r="2.5" />
        <path d="M12 8v3.5M12 11.5 6.8 15.8M12 11.5l5.2 4.3" />
      </svg>
    </span>
  )
}

export function App() {
  const [route, setRoute] = useState<Route>({ page: 'agents' })
  const [dark, toggleTheme] = useTheme()
  const current = NAV.find((n) => n.id === route.page)!

  return (
    <DataProvider>
      <NavCtx.Provider value={{ route, go: setRoute }}>
        <div className="flex min-h-full flex-col md:h-full md:flex-row">
          <nav
            aria-label="主导航"
            className="flex shrink-0 items-center gap-1 border-b bg-rail px-3 py-2 md:w-[76px] md:flex-col md:border-r md:border-b-0 md:px-0 md:py-4"
          >
            <span className="mr-2 md:mr-0 md:mb-3.5">
              <Logo />
            </span>
            {NAV.map((n) => {
              const on = n.id === route.page
              return (
                <button
                  key={n.id}
                  disabled={!n.page}
                  onClick={() => setRoute({ page: n.id })}
                  aria-current={on ? 'page' : undefined}
                  title={n.page ? n.label : `${n.label}（即将推出）`}
                  className={cn(
                    'flex cursor-pointer flex-col items-center gap-1 rounded-[10px] px-3 py-1.5 text-xs md:w-[60px] md:px-0 md:py-2',
                    on ? 'bg-accent-soft font-medium text-accent' : 'text-subtle hover:text-fg',
                    !n.page && 'cursor-not-allowed opacity-50 hover:text-subtle',
                  )}
                >
                  <n.icon className="h-5 w-5" strokeWidth={1.8} />
                  {n.label}
                </button>
              )
            })}
            <button
              onClick={toggleTheme}
              aria-label={dark ? '切换到浅色' : '切换到深色'}
              title={dark ? '切换到浅色' : '切换到深色'}
              className="ml-auto grid h-11 w-11 cursor-pointer place-items-center rounded-[10px] text-subtle hover:text-fg md:mt-auto md:ml-0"
            >
              {dark ? <Sun className="h-5 w-5" strokeWidth={1.8} /> : <Moon className="h-5 w-5" strokeWidth={1.8} />}
            </button>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col md:flex-row md:overflow-hidden">{current.page?.()}</div>
        </div>
        <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" />
      </NavCtx.Provider>
    </DataProvider>
  )
}
