import { useState } from 'react'
import { Toaster } from 'sonner'
import { Bot, FolderKanban, Moon, Sun, Workflow, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentsPage } from '@/pages/AgentsPage'

/** 侧边导航；新增页面在这里登记即可 */
const NAV: { id: string; label: string; icon: LucideIcon; page?: () => React.ReactNode }[] = [
  { id: 'agents', label: 'Agent', icon: Bot, page: () => <AgentsPage /> },
  { id: 'workflows', label: '工作流', icon: Workflow },
  { id: 'projects', label: '项目分类', icon: FolderKanban },
]

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const set = (next: boolean) => {
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {}
    setDark(next)
  }
  return [dark, set] as const
}

function ThemeSwitch({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  return (
    <div className="grid grid-cols-2 rounded-xl border bg-bg/60 p-1">
      {[
        { v: false, icon: Sun, label: '浅色' },
        { v: true, icon: Moon, label: '深色' },
      ].map((o) => (
        <button
          key={o.label}
          onClick={() => setDark(o.v)}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs transition-all',
            dark === o.v ? 'bg-surface text-fg shadow-card' : 'text-subtle hover:text-fg',
          )}
        >
          <o.icon className="h-3.5 w-3.5" />
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Logo() {
  return (
    <div className="relative grid h-9 w-9 place-items-center rounded-[11px] bg-gradient-to-br from-accent to-accent-2 text-white shadow-[0_8px_24px_-6px_var(--accent)]">
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="5.5" r="2.5" />
        <circle cx="5.5" cy="18" r="2.5" />
        <circle cx="18.5" cy="18" r="2.5" />
        <path d="M12 8v3.5M12 11.5 6.8 15.8M12 11.5l5.2 4.3" />
      </svg>
    </div>
  )
}

export function App() {
  const [active, setActive] = useState('agents')
  const current = NAV.find((n) => n.id === active)!
  const [dark, setDark] = useTheme()

  return (
    <div className="flex h-full">
      <aside className="hidden w-[232px] shrink-0 flex-col border-r bg-surface/50 px-3 pt-5 pb-4 backdrop-blur-xl md:flex">
        <div className="mb-7 flex items-center gap-3 px-2">
          <Logo />
          <div>
            <div className="text-[14px] font-semibold tracking-tight">Agent 面板</div>
            <div className="text-[11px] text-subtle">本机 Agent 编排</div>
          </div>
        </div>
        <div className="mb-2 px-3 text-[11px] font-medium text-subtle">工作台</div>
        <nav className="space-y-0.5">
          {NAV.map((n) => {
            const on = active === n.id
            return (
              <button
                key={n.id}
                disabled={!n.page}
                onClick={() => setActive(n.id)}
                className={cn(
                  'group relative flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] transition-colors',
                  on ? 'bg-surface-2 font-medium text-fg shadow-card' : 'text-muted hover:bg-surface-2/70 hover:text-fg',
                  !n.page && 'cursor-not-allowed hover:bg-transparent hover:text-muted',
                )}
              >
                {on && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-gradient-to-b from-accent to-accent-2" />}
                <n.icon className={cn('h-4 w-4', on ? 'text-accent' : 'opacity-80')} />
                {n.label}
                {!n.page && (
                  <span className="ml-auto rounded-full border px-1.5 py-px text-[10px] text-subtle">即将推出</span>
                )}
              </button>
            )
          })}
        </nav>
        <div className="mt-auto space-y-3">
          <ThemeSwitch dark={dark} setDark={setDark} />
          <div className="px-2 text-[11px] text-subtle">v0.1 · 仅监听本机</div>
        </div>
      </aside>
      <main className="relative flex-1 overflow-y-auto">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b bg-bg/80 px-5 py-3 backdrop-blur-xl md:hidden">
          <Logo />
          <span className="text-[14px] font-semibold">Agent 面板</span>
          <button
            onClick={() => setDark(!dark)}
            className="ml-auto rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
            title="切换主题"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
        {current.page?.()}
      </main>
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" toastOptions={{ className: '!rounded-xl !text-[13px]' }} />
    </div>
  )
}
