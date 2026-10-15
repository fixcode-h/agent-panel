import { useState } from 'react'
import { Toaster } from 'sonner'
import { Bot, FolderKanban, Moon, Sun, Workflow, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentsPage } from '@/pages/AgentsPage'

/** 侧边导航；新增页面在这里登记即可 */
const NAV: { id: string; label: string; icon: LucideIcon; page?: () => React.ReactNode }[] = [
  { id: 'agents', label: 'Agent 配置', icon: Bot, page: () => <AgentsPage /> },
  { id: 'workflows', label: '工作流', icon: Workflow },
  { id: 'projects', label: '项目分类', icon: FolderKanban },
]

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {}
    setDark(next)
  }
  return (
    <button
      onClick={toggle}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      {dark ? '浅色模式' : '深色模式'}
    </button>
  )
}

export function App() {
  const [active, setActive] = useState('agents')
  const current = NAV.find((n) => n.id === active)!

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-surface/60 px-3 py-5 md:flex">
        <div className="mb-8 flex items-center gap-2.5 px-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-fuchsia-500 text-white shadow-lg shadow-accent/30">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Agent 面板</div>
            <div className="text-[11px] text-muted">本机编排控制台</div>
          </div>
        </div>
        <nav className="space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              disabled={!n.page}
              onClick={() => setActive(n.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                active === n.id
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-muted hover:bg-surface-2 hover:text-fg',
                !n.page && 'cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted',
              )}
            >
              <n.icon className="h-4 w-4" />
              {n.label}
              {!n.page && <span className="ml-auto text-[10px] text-muted">即将推出</span>}
            </button>
          ))}
        </nav>
        <div className="mt-auto">
          <ThemeToggle />
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{current.page?.()}</main>
      <Toaster theme="system" position="bottom-right" richColors />
    </div>
  )
}
