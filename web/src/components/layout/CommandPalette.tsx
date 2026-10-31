import { useEffect, useMemo, useRef, useState } from 'react'

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
import { useData, useNav, useTasks, type Route } from '@/lib/data'
import { cn } from '@/lib/utils'
import { TaskStatusIcon } from '@/components/tasks/TaskStatusIcon'
import { byAskedAt, taskDeleted } from '@shared/task'
import type { Task } from '@shared/schema'
import { Modal } from '@/components/ui/modal'
import { Kbd } from '@/components/ui/kbd'
import { useTaskSearch } from '@/lib/use-task-search'

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
  const { projects, agents, workflows } = useData()
  const { tasks } = useTasks()
  const { go, openSettings } = useNav()
  const [query, setQuery] = useState('')
  // 对话正文的命中：标题里的字由下面的 items 按名称过滤，正文命中按标题匹配不到它们
  const content = useTaskSearch(query)
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

  // 没输入时每组只露几条，免得列表太长；输入后按名称和副标题匹配（正文命中排在标题命中后面）
  const q = query.trim().toLowerCase()
  const contentItems = useMemo<Item[]>(() => {
    const taskOf = (id: string) => tasks.find((x) => x.id === id)
    return content.hits.map((h) => {
      const tk = taskOf(h.taskId)
      return {
        id: `m:${h.taskId}:${h.messageId}`,
        group: t('对话内容'),
        label: h.title,
        sub: h.snippet,
        icon: MessageSquare,
        // 带上消息 id：打开对话后由 message-anchor 滚到那一条（可能在折叠段里，会先展开）
        run: () =>
          go(
            tk?.projectId
              ? { page: 'projects', id: tk.projectId, sub: h.taskId, msg: h.messageId }
              : { page: 'chat', id: h.taskId, msg: h.messageId },
          ),
      }
    })
  }, [content.hits, tasks, go])
  const shown = useMemo(() => {
    if (q)
      return [
        ...items.filter((x) => `${x.label} ${x.sub ?? ''}`.toLowerCase().includes(q)).slice(0, 60),
        ...contentItems,
      ]
    const per = new Map<string, number>()
    return items.filter((x) => {
      const n = (per.get(x.group) ?? 0) + 1
      per.set(x.group, n)
      return n <= 6
    })
  }, [items, q, contentItems])
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('命令面板')}
      bare
      closeOnOutside
      // 不垂直居中：固定在上方，输入框的位置不随结果条数上下跳
      className="top-[12vh] max-h-[70vh] max-w-[600px] translate-y-0"
    >
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
          className="h-12 min-w-0 flex-1 bg-transparent text-heading outline-none placeholder:text-subtle"
        />
      </label>
      <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && (
          <p className="px-3 py-6 text-center text-body text-subtle">
            {content.loading ? t('搜索中…') : t('没有找到')}
          </p>
        )}
        {shown.map((x, i) => (
          <div key={x.id}>
            {(i === 0 || shown[i - 1].group !== x.group) && (
              <p className="px-2.5 pt-2 pb-1 text-caption font-medium text-subtle">{x.group}</p>
            )}
            <div
              id={`palette-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === cur}
              onMouseMove={() => i !== cur && setIndex(i)}
              onClick={() => pick(x)}
              className={cn(
                'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-body',
                i === cur ? 'bg-sel text-fg' : 'text-muted',
              )}
            >
              {x.status ?? (x.icon && <x.icon className="h-4 w-4 shrink-0 text-subtle" />)}
              <span className="min-w-0 shrink truncate">{x.label}</span>
              {x.sub && <span className="min-w-0 flex-1 truncate text-xs text-subtle">{x.sub}</span>}
              {x.keys && <Kbd className="ml-auto shrink-0">{x.keys}</Kbd>}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 bg-panel/60 px-4 py-2 text-caption text-subtle">
        <span>{t('↑↓ 选择 · Enter 打开')}</span>
        <span>{t('{mod}K 命令面板', { mod: MOD })}</span>
        <span>{t('{mod}Enter 打断并发送', { mod: MOD })}</span>
        <span>{t('Esc 停止正在执行的任务')}</span>
      </div>
    </Modal>
  )
}

/** 焦点在可输入的地方（输入框、文本区、可编辑区域）：单键快捷键（?）不能抢用户打的字 */
const typing = (el: Element | null) =>
  !!el &&
  (el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]') ||
    !!el.closest('[contenteditable="true"]'))

/**
 * 同一栏里的对话顺序：和侧栏一样，项目里的顶层对话、或聊天，按最近活动排。
 * Alt+↑ / Alt+↓ 按这个顺序切换
 */
function siblingTasks(tasks: Task[], route: Route) {
  const inProject = route.page === 'projects' && !!route.id
  return tasks
    .filter((x) => !taskDeleted(x) && !x.parentTaskId && (inProject ? x.projectId === route.id : !x.projectId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 全局快捷键：⌘K 命令面板，⌘⇧O 新建任务，⌘B 收起侧栏，Alt+↑/↓ 切对话，? 快捷键一览 */
export function useShortcuts(openPalette: () => void, openHelp?: () => void) {
  const { go, route } = useNav()
  const { tasks } = useTasks()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && openHelp && !typing(document.activeElement)) {
        e.preventDefault()
        openHelp()
        return
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const cur = route.page === 'projects' ? route.sub : route.page === 'chat' ? route.id : undefined
        if (!cur || (route.page !== 'projects' && route.page !== 'chat')) return
        const list = siblingTasks(tasks, route)
        const i = list.findIndex((x) => x.id === cur)
        const next = list[i + (e.key === 'ArrowDown' ? 1 : -1)]
        if (i < 0 || !next) return
        e.preventDefault()
        go(next.projectId ? { page: 'projects', id: next.projectId, sub: next.id } : { page: 'chat', id: next.id })
        return
      }
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
  }, [go, openPalette, openHelp, route, tasks])
}
