import { useState } from 'react'
import { showParentTab } from '@/lib/ai-window'
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
import { askedAt, byAskedAt, taskBusy, taskDoneDot, taskState } from '@shared/task'
import {
  SIDEBAR_BLOCK_ROW_OFF,
  SIDEBAR_BLOCK_ROW_ON,
  SIDEBAR_GROUP_LABEL,
  SIDEBAR_ROW_OFF,
  SIDEBAR_ROW_ON,
  TaskRowStatus,
} from '@/components/ui/sidebar'
import { UnreadDot } from '@/components/ui/badge'
import type { SearchHit } from '@shared/task-search'
import { useTaskSearch } from '@/lib/use-task-search'
import { isTaskUnread, useUnreadTasks } from '@/lib/task-unread'

// 侧栏里的任务列表：一行任务、搜索和筛选、聊天列表

// 行的选中 / 悬停外观和分组标题定义在侧栏部件里（components/ui/sidebar.tsx），这里转出去给设计列表用
export { SIDEBAR_GROUP_LABEL, SIDEBAR_ROW_OFF, SIDEBAR_ROW_ON } from '@/components/ui/sidebar'

/** Chat 列表的选中行：浅卡片底加粗，和左栏底色拉开（Chat.dc.html） */
const SIDEBAR_CHAT_ON = 'border-transparent bg-card font-medium text-fg'

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
  plain,
  inBlock,
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
  /**
   * Chat 列表的行（Chat.dc.html）：只有标题，不画对话图标和时间（分组已经写了是哪天），
   * 未读点挪到行尾；选中是浅卡片底，和左栏底色拉开。转圈、需要处理、失败的图标照常画
   */
  plain?: boolean
  /** 放在项目下的任务块里（SidebarTaskBlock）：块已经垫了浅底，选中行换成更亮的卡片底 */
  inBlock?: boolean
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
            onClick={() => {
              // 已经打开着这个对话：子对话页签可能在前台，切回父对话
              if (active) showParentTab(task.id)
              onOpen()
            }}
            aria-current={active || undefined}
            title={task.title}
            data-cli-alive={alive || undefined}
            className={
              plain
                ? cn(
                    'group/row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border text-left text-[0.8125rem] transition-colors',
                    active ? (plain ? SIDEBAR_CHAT_ON : SIDEBAR_ROW_ON) : SIDEBAR_ROW_OFF,
                    className,
                  )
                : cn(
                    'group/row flex h-8 w-full cursor-pointer items-center gap-2 rounded-[7px] border text-left text-[0.8125rem] transition-colors',
                    active
                      ? cn(inBlock ? SIDEBAR_BLOCK_ROW_ON : SIDEBAR_ROW_ON, 'font-medium')
                      : inBlock
                        ? SIDEBAR_BLOCK_ROW_OFF
                        : SIDEBAR_ROW_OFF,
                    className,
                  )
            }
          >
            {/* Chat 列表（plain）的行由 Chat 页那边定；项目列表和搜索结果是组件库的 TaskRow：行尾一个状态胶囊 */}
            {plain ? (
              <>
                {/* 内容整体右缩一点，标题文字不至于一直顶到右边的时间上。缩进不能写进行上的 pl-*：
                行样式后跟调用方传的 px-*，cn 走 twMerge 会把它覆盖掉。放在行内这一层，
                选中 / hover 的背景（画在行上）仍然铺满整行 */}
                <span className={cn('flex min-w-0 flex-1 items-center gap-2', !plain && 'pl-2')}>
                  {unreadDot && !plain && <UnreadDot />}
                  <span className={cn('flex shrink-0 items-center gap-1', plain && !attention && 'hidden')}>
                    {/* 转圈时只留转圈：对话 / 工作流的图标停了再显示（用户 2026-10-24 要求） */}
                    {attention !== 'running' && !plain && (
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
                  {!plain && (
                    <span
                      className={cn(
                        'shrink-0 pl-1.5 text-[0.6875rem] tabular-nums transition-colors',
                        active ? 'text-muted' : 'text-subtle group-hover/row:text-muted',
                      )}
                    >
                      {shortTime(askedAt(task), timeOnly)}
                    </span>
                  )}
                  {unreadDot && plain && <UnreadDot className="mr-0.5 h-[7px] w-[7px]" />}
                </span>
              </>
            ) : (
              <>
                {/* 内容整体右缩一点，标题文字不至于一直顶到右边的状态上。缩进不能写进行上的 pl-*：
                行样式后跟调用方传的 px-*，cn 走 twMerge 会把它覆盖掉。放在行内这一层，
                选中 / hover 的背景（画在行上）仍然铺满整行 */}
                <span className="flex min-w-0 flex-1 items-center gap-2 pl-[3px]">
                  {/* 只给工作流画图标：普通对话占大多数，每行都画只会和行尾状态抢眼（组件库的任务行不带图标） */}
                  {task.mode === 'workflow' && (
                    <Workflow
                      aria-label={t('工作流')}
                      className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-muted' : 'text-subtle')}
                    />
                  )}
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
                  {/* 行尾只放一个状态（等你回复 / N 子对话 / 执行中 / 失败 / 未读点），和 StatusPill 同一套颜色 */}
                  <TaskRowStatus
                    needs={attention === 'ask'}
                    kids={busy ? (task.childrenWorking ?? 0) : 0}
                    running={busy}
                    failed={attention === 'failed'}
                    unread={unreadDot}
                  />
                  {/* 没有状态时才显示时间；时间格自己留一段左间距，标题截断后和时间之间也有明显间隔 */}
                  {!attention && !unreadDot && (
                    <span
                      className={cn(
                        'shrink-0 pl-1.5 text-[0.6875rem] tabular-nums transition-colors',
                        active ? 'text-muted' : 'text-subtle group-hover/row:text-muted',
                      )}
                    >
                      {shortTime(askedAt(task), timeOnly)}
                    </span>
                  )}
                </span>
              </>
            )}
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

/**
 * 聊天列表按「置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更早」分段（Chat.dc.html）：聊天多是一次性的，
 * 按具体日期一天一组会切得太碎，扫一眼找不到；list 已经按最近发言排好，分段后组内顺序不变。
 * 置顶的聊天只出现在最上面那一组，不在日期组里重复
 */
function chatBuckets(list: Task[], now = new Date()) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = day(now)
  const pinned = { key: 'pinned', label: t('已置顶'), items: [] as Task[] }
  const buckets = [
    pinned,
    { key: 'today', label: t('今天'), items: [] as Task[] },
    { key: 'yesterday', label: t('昨天'), items: [] as Task[] },
    { key: 'week', label: t('7 天内'), items: [] as Task[] },
    { key: 'month', label: t('30 天内'), items: [] as Task[] },
    { key: 'older', label: t('更早'), items: [] as Task[] },
  ]
  for (const x of list) {
    if (x.pinned) {
      pinned.items.push(x)
      continue
    }
    // 跨夏令时的那天相差 23 / 25 小时，取整
    const diff = Math.round((today - day(new Date(askedAt(x)))) / 86400000)
    buckets[diff <= 0 ? 1 : diff === 1 ? 2 : diff < 7 ? 3 : diff < 30 ? 4 : 5].items.push(x)
  }
  return buckets.filter((b) => b.items.length)
}

export function ChatList() {
  const { route, go } = useNav()
  const { tasks } = useData()
  // 未读橙点和项目列表同一个口径：服务端的 turnDoneAt / turnSeenAt，加上刚完成还没刷新的本地记录
  const unread = useUnreadTasks()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [folded, toggleDay] = useFoldedDays()
  // 正文命中：和项目列表那份是同一个接口、同一个 hook，标题命中仍在前
  const content = useTaskSearch(query)
  const chats = tasks.filter((x) => !x.projectId && matchTask(x, query, filter)).sort(byAskedAt)
  const filtering = !!query.trim() || filter !== 'all'
  const chatHits = content.hits.filter((h) => !tasks.find((x) => x.id === h.taskId)?.projectId)
  const days = chatBuckets(chats)
  return (
    <div data-chat-list className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <TaskSearch query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} placeholder={t('搜索聊天')} />
      {/* 不筛选时分段标题本身就说明了时间，不再多一行「最近」 */}
      {filtering && (
        <p className={cn('flex h-7 shrink-0 items-center px-2.5', SIDEBAR_GROUP_LABEL)}>
          {t('找到 {n} 个', { n: chats.length + Math.min(chatHits.length, SIDEBAR_CONTENT_HITS) })}
        </p>
      )}
      {chats.length === 0 && !chatHits.length && (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <MessagesSquare className="h-5 w-5 text-subtle" strokeWidth={1.6} />
          <p className="text-xs leading-relaxed text-subtle">{filtering ? t('没有符合的聊天。') : t('还没有聊天。')}</p>
        </div>
      )}
      {days.map((d) => {
        const open = !folded.has(d.key)
        return (
          <div key={d.key} data-chat-group={d.key} className="flex flex-col gap-px">
            {/* 分段标题照设计稿只是一行小字；点它仍能收起这一段，箭头悬停或收起时才露出来 */}
            <button
              onClick={() => toggleDay(d.key)}
              aria-expanded={open}
              className={cn(
                'group/day flex h-7 shrink-0 cursor-pointer items-end gap-1 px-2.5 pb-1 transition-colors hover:text-fg',
                SIDEBAR_GROUP_LABEL,
                'font-semibold tracking-[0.06em]',
              )}
            >
              <span className="truncate">{d.label}</span>
              {!open && <span className="shrink-0 tabular-nums">· {d.items.length}</span>}
              <ChevronDown
                className={cn(
                  'mb-px h-3 w-3 shrink-0 transition-[transform,opacity]',
                  open ? 'opacity-0 group-hover/day:opacity-100' : '-rotate-90',
                )}
              />
            </button>
            {open &&
              d.items.map((tk) => (
                <TaskRow
                  key={tk.id}
                  task={tk}
                  plain
                  unread={isTaskUnread(tk) || unread.includes(tk.id)}
                  active={route.page === 'chat' && route.id === tk.id}
                  onOpen={() => go({ page: 'chat', id: tk.id })}
                  onDeleted={() => route.page === 'chat' && route.id === tk.id && go({ page: 'chat' })}
                  className="h-[30px] px-2.5"
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
