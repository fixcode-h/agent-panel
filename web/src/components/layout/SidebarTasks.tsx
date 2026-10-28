import { useState } from 'react'
import {
  Check,
  ChevronDown,
  CircleAlert,
  ListFilter,
  MessageSquare,
  MessagesSquare,
  Search,
  Workflow,
  X,
} from 'lucide-react'
import type { Task } from '@shared/schema'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { TaskStatusIcon } from '@/components/tasks/TaskStatusIcon'
import { AnalysisMark } from '@/components/tasks/AnalysisMark'
import { cliAliveHint, cliTreeAlive } from '@/components/tasks/CliAlive'
import { isAnalysisTask } from '@/lib/analysis-report'
import { TaskRenameInput, useTaskRowMenu } from '@/components/tasks/TaskMenu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@/components/ui/menu'
import { t } from '@shared/i18n'
import { askedAt, byAskedAt, groupByDay, taskBusy, taskDoneDot, taskState } from '@shared/task'
import { UnreadDot } from '@/components/ui/badge'
import type { SearchHit } from '@shared/task-search'
import { useTaskSearch } from '@/lib/use-task-search'

// 侧栏里的任务列表：一行任务、搜索和筛选、聊天列表

/**
 * 侧栏一行的选中 / 悬停外观：和中间列表的选中项一致（细边框 + 微阴影）。
 * 导航、项目分组、任务行和设计行都引用这里，选中态只定义一次；用的时候基础类里要带 `border`。
 */
export const SIDEBAR_ROW_ON = 'border-transparent bg-sel text-fg'
export const SIDEBAR_ROW_OFF = 'border-transparent text-muted hover:bg-sel/60 hover:text-fg'

/** 分组标题（项目 / 对话内容 / 按天）：小一号、字距略宽，和可点的行拉开层级 */
export const SIDEBAR_GROUP_LABEL = 'text-[0.6875rem] font-medium tracking-[0.04em] text-subtle'

/** timeOnly：分组已经写了日期，行里只留时分 */
export function shortTime(iso: string, timeOnly = false) {
  const d = new Date(iso)
  if (timeOnly) return d.toTimeString().slice(0, 5)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // 跨夏令时的那天相差 23 / 25 小时，取整
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000)
  if (diff <= 0) return d.toTimeString().slice(0, 5)
  if (diff === 1) return t('昨天')
  if (diff < 7) return t('{n} 天前', { n: diff })
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 每个项目默认显示的任务数，多的点「更多」展开 */

export function TaskRow({
  task,
  active,
  onOpen,
  onDeleted,
  hint,
  unread,
  timeOnly,
  className,
}: {
  task: Task
  active: boolean
  onOpen: () => void
  onDeleted: () => void
  /** 时间前面的小字，搜索结果里显示所属项目 */
  hint?: string
  /** 项目里的对话完成了、用户还没打开看过 */
  unread?: boolean
  /** 分组已经写了日期，行里只显示时分 */
  timeOnly?: boolean
  className?: string
}) {
  const menu = useTaskRowMenu(task, onDeleted)
  const { agents } = useData()
  if (menu.renaming)
    return <TaskRenameInput task={task} onCommit={menu.rename} onCancel={() => menu.setRenaming(false)} />
  // 状态只从 taskState 来（和标题栏、项目首页同一个判定）：自己在执行、在等子对话 / 子任务 / 后台命令 / 工作流
  // 都转圈；有没回复的提问、请求是「需要你处理」
  const state = taskState(task)
  const busy = state === 'running' || state === 'waiting'
  // 自己或名下子对话有活着的 CLI：标题流光，不点开也能看出来
  const alive = cliTreeAlive(task)
  const ModeIcon = task.mode === 'workflow' ? Workflow : MessageSquare
  // AI 分析开出的对话：标题前加强调色的标签，和普通对话一眼分开
  const analysis = isAnalysisTask(task, agents)
  const attention = state === 'needs' ? 'ask' : busy ? 'running' : state === 'failed' ? 'failed' : ''
  // 橙点只在对话真的停在完成态、而且不是当前打开的那个时才画（见 taskDoneDot）：
  // 未读可能是上一轮留下的，对话后来又跑起来时会和转圈撞在同一行
  const unreadDot = taskDoneDot(task, !!unread, active)
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={onOpen}
            aria-current={active || undefined}
            title={task.title}
            data-cli-alive={alive || undefined}
            className={cn(
              'group/row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border text-left text-[0.8125rem] transition-colors',
              active ? SIDEBAR_ROW_ON : SIDEBAR_ROW_OFF,
              className,
            )}
          >
            {/* 内容整体右缩一点，标题文字不至于一直顶到右边的时间上。缩进不能写进行上的 pl-*：
                行样式后跟调用方传的 px-*，cn 走 twMerge 会把它覆盖掉。放在行内这一层，
                选中 / hover 的背景（画在行上）仍然铺满整行 */}
            <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
              {unreadDot && <UnreadDot />}
              <span className="flex shrink-0 items-center gap-1">
                {/* 转圈时只留转圈：对话 / 工作流的图标停了再显示（用户 2026-10-24 要求） */}
                {attention !== 'running' && (
                  <ModeIcon
                    aria-label={task.mode === 'workflow' ? t('工作流') : t('对话')}
                    className={cn('h-3.5 w-3.5', active ? 'text-muted' : 'text-subtle')}
                  />
                )}
                {attention === 'ask' ? (
                  // Agent 在等你确认操作或回答问题
                  <CircleAlert
                    aria-label={t('需要你处理')}
                    className="h-3.5 w-3.5 shrink-0 text-warning"
                    strokeWidth={2.4}
                  />
                ) : attention === 'running' || attention === 'failed' ? (
                  <TaskStatusIcon
                    status={attention === 'running' ? 'running' : task.status}
                    working={attention === 'running'}
                    className="h-3.5 w-3.5"
                  />
                ) : null}
              </span>
              {analysis && <AnalysisMark kind={task.analysis} />}
              {/* 行的 title 只放标题（别处按它找这一行）：CLI 存活的说明挂在标题文字上 */}
              <span
                title={alive ? `${task.title}\n${cliAliveHint(task)}` : undefined}
                className={cn('min-w-0 flex-1 truncate', alive && 'cli-alive-title')}
                style={alive && !active ? ({ '--cli-base': 'var(--muted)' } as React.CSSProperties) : undefined}
              >
                {task.title}
              </span>
              {hint && <span className="max-w-[40%] shrink truncate text-[0.6875rem] text-subtle">{hint}</span>}
              {/* 时间格自己留一段左间距（在 gap-2 之外再加 6px）：标题再长，截断后和时间之间也有明显间隔 */}
              <span
                className={cn(
                  'shrink-0 pl-1.5 text-[0.6875rem] tabular-nums transition-colors',
                  active ? 'text-muted' : 'text-subtle group-hover/row:text-muted',
                )}
              >
                {shortTime(askedAt(task), timeOnly)}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>{menu.items}</ContextMenuContent>
      </ContextMenu>
      {menu.confirm}
    </>
  )
}

export type TaskFilter = 'all' | 'running' | 'failed' | 'waiting' | 'archived'
export const FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: t('全部') },
  { id: 'running', label: t('执行中') },
  { id: 'failed', label: t('失败') },
  { id: 'waiting', label: t('等我处理') },
  { id: 'archived', label: t('已归档') },
]

/** 按标题和第一条要求搜索，按状态筛选；归档的只在「已归档」里出现 */
export function matchTask(tk: Task, query: string, filter: TaskFilter) {
  if (filter === 'archived' ? !tk.archived : tk.archived) return false
  if (filter === 'running' && !taskBusy(tk)) return false
  if (filter === 'failed' && tk.status !== 'failed') return false
  if (filter === 'waiting' && !tk.requests?.length && !tk.awaitingUser) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  const first = tk.messages.find((m) => m.role === 'user')?.text ?? ''
  return tk.title.toLowerCase().includes(q) || first.toLowerCase().includes(q)
}

/** 侧栏顶部的搜索框和筛选 */
export function TaskSearch({
  query,
  onQuery,
  filter,
  onFilter,
  placeholder,
}: {
  query: string
  onQuery: (q: string) => void
  filter: TaskFilter
  onFilter: (f: TaskFilter) => void
  placeholder: string
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 px-0.5 pb-1.5">
      {/* 边框平时很淡、悬停加深、聚焦时换成焦点色并带一圈柔光，和中间列表的搜索框一致 */}
      <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line/80 bg-field/50 px-2 text-[0.8125rem] transition-colors hover:border-line-strong/80 hover:bg-field/80 focus-within:border-focus/70 focus-within:bg-field focus-within:ring-[3px] focus-within:ring-focus-soft/60">
        <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <input
          id="sidebar-search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && (query || filter !== 'all')) {
              e.stopPropagation()
              onQuery('')
              onFilter('all')
              e.currentTarget.blur()
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle"
        />
        {query && (
          <button
            onClick={() => onQuery('')}
            aria-label={t('清除搜索')}
            className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </label>
      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label={t('筛选')}
            title={filter === 'all' ? t('筛选') : FILTERS.find((f) => f.id === filter)?.label}
            className={cn(
              'grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md border transition-colors',
              filter === 'all'
                ? 'border-transparent text-subtle hover:bg-sel hover:text-fg'
                : 'border-accent/30 bg-accent-soft text-accent',
            )}
          >
            <ListFilter className="h-3.5 w-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          {FILTERS.map((f) => (
            <MenuItem key={f.id} onSelect={() => onFilter(f.id)}>
              <Check className={cn('h-4 w-4', f.id !== filter && 'invisible')} />
              {f.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  )
}

/** 收起的「按日分组」记在本机浏览器里，下次打开还是收起的 */
function useFoldedDays() {
  const [v, set] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('sidebar-chat-days') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggle = (key: string) =>
    set((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      try {
        localStorage.setItem('sidebar-chat-days', JSON.stringify([...next]))
      } catch {}
      return next
    })
  return [v, toggle] as const
}

/** Chat 模式的侧栏：聊天按天分组，组可以收起；右键可以重命名、归档、删除 */
/** 侧栏最多显示几条正文命中：再多就把下面的列表挤不见了 */
export const SIDEBAR_CONTENT_HITS = 6

/**
 * 对话正文里的命中（走服务端 GET /tasks/search）：标题 + 命中片段，点开跳到那条消息。
 * 标题命中由外围的 TaskRow 排在前面，这里只接后面的那一段；项目列表和聊天列表共用
 */
export function ContentHits({
  hits,
  loading,
  onOpen,
}: {
  hits: SearchHit[]
  loading: boolean
  onOpen: (h: SearchHit) => void
}) {
  if (!hits.length) return loading ? <p className="px-2.5 py-2 text-xs text-subtle">{t('正在搜对话内容…')}</p> : null
  return (
    <div className="mt-1 flex flex-col gap-px">
      <p className={cn('flex h-7 shrink-0 items-center px-2.5', SIDEBAR_GROUP_LABEL)}>{t('对话内容')}</p>
      {hits.slice(0, SIDEBAR_CONTENT_HITS).map((h) => (
        <button
          key={`${h.taskId}:${h.messageId}`}
          onClick={() => onOpen(h)}
          title={h.snippet}
          className="flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-md border border-transparent px-2.5 py-1.5 text-left text-[0.8125rem] text-muted transition-colors hover:bg-sel/60 hover:text-fg"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="truncate">{h.title}</span>
          </span>
          <span className="min-w-0 truncate pl-5 text-xs text-subtle">{h.snippet}</span>
        </button>
      ))}
    </div>
  )
}

export function ChatList() {
  const { route, go } = useNav()
  const { tasks } = useData()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [folded, toggleDay] = useFoldedDays()
  // 正文命中：和项目列表那份是同一个接口、同一个 hook，标题命中仍在前
  const content = useTaskSearch(query)
  const chats = tasks.filter((x) => !x.projectId && matchTask(x, query, filter)).sort(byAskedAt)
  const filtering = !!query.trim() || filter !== 'all'
  const chatHits = content.hits.filter((h) => !tasks.find((x) => x.id === h.taskId)?.projectId)
  const days = groupByDay(chats, askedAt)
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto border-t px-2 pt-2 pb-2">
      <TaskSearch query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} placeholder={t('搜索聊天')} />
      <p className={cn('flex h-7 shrink-0 items-center px-2.5', SIDEBAR_GROUP_LABEL)}>
        {filtering
          ? t('找到 {n} 个', { n: chats.length + Math.min(chatHits.length, SIDEBAR_CONTENT_HITS) })
          : t('最近')}
      </p>
      {chats.length === 0 && !chatHits.length && (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <MessagesSquare className="h-5 w-5 text-subtle" strokeWidth={1.6} />
          <p className="text-xs leading-relaxed text-subtle">{filtering ? t('没有符合的聊天。') : t('还没有聊天。')}</p>
        </div>
      )}
      {days.map((d) => {
        const open = !folded.has(d.key)
        return (
          <div key={d.key} className="flex flex-col gap-px">
            <button
              onClick={() => toggleDay(d.key)}
              aria-expanded={open}
              className={cn(
                'flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 transition-colors hover:bg-sel/40 hover:text-fg',
                SIDEBAR_GROUP_LABEL,
              )}
            >
              <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', !open && '-rotate-90')} />
              <span className="truncate">{d.label}</span>
              <span className="shrink-0">· {d.items.length}</span>
            </button>
            {open &&
              d.items.map((tk) => (
                <TaskRow
                  key={tk.id}
                  task={tk}
                  timeOnly
                  active={route.page === 'chat' && route.id === tk.id}
                  onOpen={() => go({ page: 'chat', id: tk.id })}
                  onDeleted={() => route.page === 'chat' && route.id === tk.id && go({ page: 'chat' })}
                  className="px-2.5"
                />
              ))}
          </div>
        )
      })}
      <ContentHits
        hits={chatHits}
        loading={content.loading}
        onOpen={(h) => go({ page: 'chat', id: h.taskId, msg: h.messageId })}
      />
    </div>
  )
}

/** 左侧栏：参考 Claude Code，上面是新建和导航，中间是最近任务，下面是设置 */
