import { useEffect, useMemo, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import {
  Bot,
  FolderGit2,
  MessageSquare,
  MessageSquarePlus,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'
import { t } from '@shared/i18n'
import { listableAgents } from '@shared/builtin/core'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { TaskStatusIcon } from '@/components/tasks/TaskStatusIcon'
import { byAskedAt } from '@shared/task'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** 快捷键的显示：Mac 上是 ⌘，其他系统是 Ctrl */
export const MOD = isMac ? '⌘' : 'Ctrl+'

/** 侧栏收起 / 展开：快捷键和命令面板都发这个事件，侧栏自己切换 */
export const TOGGLE_SIDEBAR = 'agent-panel:toggle-sidebar'
export const toggleSidebar = () => window.dispatchEvent(new Event(TOGGLE_SIDEBAR))

type Item = {
  id: string
  group: string
  label: string
  sub?: string
  icon?: LucideIcon
  status?: React.ReactNode
  keys?: string
  run: () => void
}

/**
 * 命令面板（⌘K / Ctrl+K）：跳到项目、任务、聊天、Agent、工作流，或者执行常用操作。
 * 方向键选择，Enter 打开，Esc 关闭。
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { projects, tasks, agents, workflows } = useData()
  const { go, openSettings } = useNav()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? ''
    const recent = [...tasks].filter((x) => !x.archived).sort(byAskedAt)
    return [
      {
        id: 'new-task',
        group: t('操作'),
        label: t('新建任务'),
        icon: SquarePen,
        keys: `${MOD}${isMac ? '⇧' : 'Shift+'}O`,
        run: () => go({ page: 'home' }),
      },
      {
        id: 'new-chat',
        group: t('操作'),
        label: t('新建聊天'),
        icon: MessageSquarePlus,
        run: () => go({ page: 'chat' }),
      },
      {
        id: 'sidebar',
        group: t('操作'),
        label: t('收起 / 展开侧栏'),
        icon: PanelLeft,
        keys: `${MOD}B`,
        run: toggleSidebar,
      },
      { id: 'settings', group: t('操作'), label: t('打开设置'), icon: Settings, run: () => openSettings() },
      ...projects.map((p) => ({
        id: `p:${p.id}`,
        group: t('项目'),
        label: p.name,
        sub: p.path,
        icon: FolderGit2,
        run: () => go({ page: 'projects', id: p.id }),
      })),
      ...recent.map((x) => ({
        id: `t:${x.id}`,
        group: x.projectId ? t('任务') : t('聊天'),
        label: x.title,
        sub: x.projectId ? projectName(x.projectId) : undefined,
        icon: x.projectId ? undefined : MessageSquare,
        status: <TaskStatusIcon status={x.status} working={x.working} className="h-3.5 w-3.5" />,
        run: () => go(x.projectId ? { page: 'projects', id: x.projectId, sub: x.id } : { page: 'chat', id: x.id }),
      })),
      ...listableAgents(agents).map((a) => ({
        id: `a:${a.id}`,
        group: t('角色'),
        label: a.name,
        sub: a.description,
        icon: Bot,
        run: () => go({ page: 'agents', id: a.id }),
      })),
      ...workflows.map((w) => ({
        id: `w:${w.id}`,
        group: t('工作流'),
        label: w.name,
        sub: w.description,
        icon: WorkflowIcon,
        run: () => go({ page: 'workflows', id: w.id }),
      })),
    ]
  }, [projects, tasks, agents, workflows, go, openSettings])

  // 没输入时每组只露几条，免得列表太长；输入后按名称和副标题匹配
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (q) return items.filter((x) => `${x.label} ${x.sub ?? ''}`.toLowerCase().includes(q)).slice(0, 60)
    const per = new Map<string, number>()
    return items.filter((x) => {
      const n = (per.get(x.group) ?? 0) + 1
      per.set(x.group, n)
      return n <= 6
    })
  }, [items, q])
  const cur = Math.min(index, Math.max(0, shown.length - 1))
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cur}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cur])

  const pick = (x?: Item) => {
    if (!x) return
    onOpenChange(false)
    x.run()
  }

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40 animate-[fade-in_120ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[calc(100%-2rem)] max-w-[600px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-2xl animate-[pop-in_140ms_ease-out] focus:outline-none"
        >
          <D.Title className="sr-only">{t('命令面板')}</D.Title>
          <label className="flex items-center gap-2.5 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setIndex(0)
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setIndex((i) => Math.min(i + 1, shown.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setIndex((i) => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  pick(shown[cur])
                }
              }}
              placeholder={t('搜索项目、任务、角色、工作流，或者输入操作')}
              aria-label={t('搜索')}
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={shown[cur] ? `palette-${cur}` : undefined}
              className="h-12 min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-subtle"
            />
          </label>
          <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {shown.length === 0 && (
              <p className="px-3 py-6 text-center text-[0.8125rem] text-subtle">{t('没有找到')}</p>
            )}
            {shown.map((x, i) => (
              <div key={x.id}>
                {(i === 0 || shown[i - 1].group !== x.group) && (
                  <p className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-subtle">{x.group}</p>
                )}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === cur}
                  onMouseMove={() => i !== cur && setIndex(i)}
                  onClick={() => pick(x)}
                  className={cn(
                    'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[0.84375rem]',
                    i === cur ? 'bg-sel text-fg' : 'text-muted',
                  )}
                >
                  {x.status ?? (x.icon && <x.icon className="h-4 w-4 shrink-0 text-subtle" />)}
                  <span className="min-w-0 shrink truncate">{x.label}</span>
                  {x.sub && <span className="min-w-0 flex-1 truncate text-xs text-subtle">{x.sub}</span>}
                  {x.keys && (
                    <kbd className="ml-auto shrink-0 rounded border bg-field px-1.5 font-mono text-[0.6875rem] text-subtle">
                      {x.keys}
                    </kbd>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t bg-panel/60 px-4 py-2 text-[0.71875rem] text-subtle">
            <span>{t('↑↓ 选择 · Enter 打开')}</span>
            <span>{t('{mod}K 命令面板', { mod: MOD })}</span>
            <span>{t('{mod}Enter 打断并发送', { mod: MOD })}</span>
            <span>{t('Esc 停止正在执行的任务')}</span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 全局快捷键：⌘K 命令面板，⌘⇧O 新建任务，⌘B 收起侧栏 */
export function useShortcuts(openPalette: () => void) {
  const { go } = useNav()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'k' && !e.shiftKey) {
        e.preventDefault()
        openPalette()
      } else if (k === 'o' && e.shiftKey) {
        // 浏览器不让网页占用 Ctrl+N，新建任务用 Ctrl+Shift+O（和常见的聊天应用一样）
        e.preventDefault()
        go({ page: 'home' })
      } else if (k === 'b' && !e.shiftKey) {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, openPalette])
}
