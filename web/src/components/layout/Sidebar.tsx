import { useEffect, useState } from 'react'
import { useEscape } from '@/lib/useEscape'
import {
  Bot,
  FolderKanban,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sun,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { Task } from '@shared/schema'
import { useData, useNav, type PageId } from '@/lib/data'
import { cn } from '@/lib/utils'
import { useAppUpdate } from '@/lib/app-update'
import { TaskStatusIcon } from '@/components/tasks/TaskStatusIcon'

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
  { id: 'projects', label: '项目', icon: FolderKanban },
  { id: 'agents', label: 'Agent', icon: Bot },
  { id: 'workflows', label: '工作流', icon: Workflow },
]

function dayGroup(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // 跨夏令时的那天相差 23 / 25 小时，取整
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff < 7) return '近 7 天'
  return '更早'
}

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

/** 左侧栏：参考 Claude Code，上面是新建和导航，中间是最近任务，下面是设置 */
export function Sidebar({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { route, go, openSettings } = useNav()
  const { tasks, projects } = useData()
  // 有可以安装的新版本时在「设置」上提示（在线演示不提示）
  const appUpdate = useAppUpdate().data
  const update = !import.meta.env.VITE_DEMO && appUpdate?.packaged ? appUpdate.update : undefined
  const [collapsed, toggleCollapsed] = useCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => setMobileOpen(false), [route])
  useEscape(mobileOpen, () => setMobileOpen(false))

  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
  const groups = new Map<string, Task[]>()
  for (const t of recent) groups.set(dayGroup(t.updatedAt), [...(groups.get(dayGroup(t.updatedAt)) ?? []), t])
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? ''
  const running = tasks.filter((t) => t.status === 'running').length

  const body = (narrow: boolean) => (
    <>
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 px-3', narrow && 'justify-center px-0')}>
        {!narrow && (
          <button onClick={() => go({ page: 'home' })} className="flex min-w-0 cursor-pointer items-center gap-2.5">
            <Logo />
            <span className="truncate font-serif text-[16px] font-semibold tracking-tight">Agent 面板</span>
          </button>
        )}
        <button
          onClick={toggleCollapsed}
          aria-label={narrow ? '展开侧栏' : '收起侧栏'}
          title={narrow ? '展开侧栏' : '收起侧栏'}
          className="ml-auto hidden h-8 w-8 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel hover:text-fg md:grid"
        >
          {narrow ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
        </button>
      </div>

      <nav aria-label="主导航" className={cn('flex flex-col gap-0.5 px-2', narrow && 'items-center')}>
        <Row
          icon={Plus}
          label="新建任务"
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
      </nav>

      {!narrow ? (
        <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
          {recent.length === 0 && (
            <p className="px-2.5 pt-2 text-xs leading-relaxed text-subtle">还没有任务。点「新建任务」描述要做的事。</p>
          )}
          {[...groups].map(([label, ts]) => (
            <section key={label} className="mb-3">
              <h3 className="px-2.5 pb-1 text-xs text-subtle">
                {label}
                {label === '今天' && running > 0 && <span className="text-accent"> · {running} 个执行中</span>}
              </h3>
              {ts.map((t) => {
                const on = route.page === 'projects' && route.sub === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => go({ page: 'projects', id: t.projectId, sub: t.id })}
                    aria-current={on || undefined}
                    title={`${t.title} · ${projectName(t.projectId)}`}
                    className={cn(
                      'group flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors',
                      on ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
                    )}
                  >
                    {t.status === 'running' || t.status === 'failed' ? (
                      <TaskStatusIcon status={t.status} className="h-3.5 w-3.5" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="max-w-[40%] shrink-0 truncate text-[11px] text-subtle">
                      {projectName(t.projectId)}
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className={cn('flex shrink-0 items-center gap-1 border-t px-2 py-2', narrow && 'flex-col')}>
        <Row
          icon={Settings}
          label="设置"
          collapsed={narrow}
          badge={update ? '有新版本' : undefined}
          onClick={() => {
            setMobileOpen(false)
            openSettings(update ? 'update' : undefined)
          }}
          className={cn(!narrow && 'flex-1')}
        />
        <button
          onClick={onToggleTheme}
          aria-label={dark ? '切换到浅色' : '切换到深色'}
          title={dark ? '切换到浅色' : '切换到深色'}
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
          aria-label="打开菜单"
          className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-muted hover:bg-sel"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Logo />
        <span className="font-serif text-[15px] font-semibold">Agent 面板</span>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="菜单"
            className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col bg-rail shadow-pop"
          >
            <button
              autoFocus
              onClick={() => setMobileOpen(false)}
              aria-label="关闭菜单"
              className="absolute top-3 right-3 z-10 grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel"
            >
              <X className="h-4 w-4" />
            </button>
            {body(false)}
          </aside>
        </div>
      )}
      <aside
        aria-label="侧栏"
        className={cn(
          'hidden shrink-0 flex-col border-r bg-rail transition-[width] duration-200 md:flex',
          collapsed ? 'w-[56px]' : 'w-[264px]',
        )}
      >
        {body(collapsed)}
      </aside>
    </>
  )
}
