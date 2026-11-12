import { Suspense, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@shared/i18n'
import { ANCHOR_RETRY_MS, ANCHOR_TRIES, jumpToMessage } from '@/lib/message-anchor'
import { useSummaryJump } from './summary-jump'
import { useQuoteTarget } from '@/lib/quote'
import { toast } from '@/lib/toast'
import { RouteProvider } from './route-context'
import { Loader2 } from 'lucide-react'
import { useDiagDialogs } from './diag-dialogs'
import { useDiagnosisHost } from './diagnosis-window'
import { useHeaderPins } from './HeaderPins'
import { taskHeaderItems } from './header-items'
import { TurnRail } from './TurnRail'
import { chatHelperIds } from './HelperCards'
import { liveWaitText } from '@shared/live/task-live'
import { latestTurnIndex } from '@/lib/latest-turn'
import type { Project, TaskMessage } from '@shared/schema'
import { blockedStep, flowUnfinished, taskFlow, taskWorkflows, topSteps } from '@shared/flow'
import { childWait } from '@shared/task'
import { withTaskModel } from '@shared/tasks/run'
import { agentRun, defaultCli, defaultSettings } from '@shared/settings'
import { getCli, steerable } from '@shared/clis'
import { api } from '@/lib/api'
import { minimizeTask, minimizeBackRoute } from '@/lib/mini-task'
import { useEscape } from '@/lib/useEscape'
import { childLetters } from '@/lib/tasks'
import { WithAgents, useData, useNav, useTasks } from '@/lib/data'
import { withImportedAgents } from '@shared/tasks/export'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConversationShell, useConversationScroll } from '@/components/chat/ConversationShell'
import { LiveStats } from './LiveStats'
import { AnalysisPanel, reportTitle } from './AnalysisPanel'
import { AnalysisMark } from './AnalysisMark'
import { findReport, isAnalysisTask } from '@/lib/analysis-report'
import { LoadTrace } from './LoadTrace'
import { RunPanel } from './RunCard'
import { RunView } from './RunView'
import { TaskPanel } from './TaskPanel'
import { EnvChip } from './TaskMeta'
import { SessionBar } from '@/components/session/SessionBar'
import { ConversationTabs } from './ConversationTabs'
import { useChatRail } from './ChatRail'
import { FileOpenCtx } from './FileDialog'
import { HandleNeedsCtx, SummaryCardsCtx } from './Markdown'
import { AiLookCtx } from '@/lib/ai-look'
import type { JobTarget } from './JobDialog'
import { ChildListCtx, ChildMailProvider, PaneNavCtx, PaneToolbarCtx, type PeerMail } from './child-open'
import { asksQuestion } from './RequestCard'
import { useSlashMenu } from '@/components/chat/SlashMenu'
import { DropOverlay, useAttachments, useFileMention } from '@/components/chat/Attachments'
import { canStartFlow } from '@shared/flow/run'
import { dropChip } from '@shared/composer'
import type { RichInputHandle } from '@/components/chat/RichInput'
import { FileRefLayer } from '@/components/files/FileRefLayer'
import { PendingReply, ChatWaitLine, RunPhase } from './TaskViewParts'
import { useTaskTabs } from '@/plugins/registry'
import { blockMsgIds, toBlocks } from './task-blocks'
// 栏宽和本地记忆、子对话列表、已读和在场、摘要节流、导出：按功能拆在这几个文件，这里只调用
import {
  BLOCK_LIMIT,
  EMBED_FILES_PANE_CAP,
  FILES_PANE_CAP,
  NO_MESSAGES,
  PANE_MIN,
  RAIL_GUTTER,
  REPORT_PANE_MIN,
  SESSION_BAR_KEY,
  SESSION_BAR_W,
  paneMax,
  useHalfPane,
  writeStored,
} from './task-view-pane'
import { useChildList, useChildPolling } from './task-view-children'
import { taskExportActions } from './task-view-actions'
// 对话页按区域拆开的部分（重构文档第 13 条）：数据、动作、开合状态是 hook，标题区、消息流、输入框、停靠区、右栏、弹窗是组件
import { useTaskLoad } from './view/use-task-load'
import { useTaskActions } from './view/use-task-actions'
import { useTaskPanes } from './view/use-task-panes'
import { railLayout } from './view/rail-layout'
import { ChatHeader, HeaderActions, HeaderBadges, HeaderNav, TaskTitle } from './view/TaskHeader'
import { TaskMessages } from './view/TaskMessages'
import { FollowComposer, flowHint } from './view/FollowComposer'
import { ConversationDock } from './view/ConversationDock'
import { TaskSideRail } from './view/TaskSideRail'
import { NO_DIALOGS, TaskDialogs, type TaskDialogState } from './view/TaskDialogs'

/** 流程图视图用到的画布库比较大，切到流程图时才加载 */
const TaskFlow = lazy(() => import('./TaskFlow').then((m) => ({ default: m.TaskFlow })))

/** 一个任务的对话页：上方是执行输出，下方继续输入要求，右侧是进度、上下文和更改 */
/** project 为空时是 Chat 模式的聊天，不属于任何项目 */

export function TaskView({
  taskId,
  project,
  embed,
  pane,
  onClose,
  jumpSummary,
}: {
  taskId: string
  project?: Project
  /** 放在弹窗里（例如「AI 处理」）：标题栏右边加上弹窗自己的按钮；要跳到别的页面时先收起弹窗 */
  embed?: {
    actions: React.ReactNode
    onLeave: () => void
    /**
     * 弹窗标题栏里留给对话操作的位置（AI 分析窗口）：给了就不画对话自己的页签行（标题和弹窗标题栏重复），
     * 状态和操作按钮挂到这里；中间开着子对话、运行页签时仍画页签行，要靠它切回来
     */
    slot?: HTMLElement | null
  }
  /** 放在对话页右侧的子对话栏里：不画自己的右栏，标题栏加上关闭按钮 */
  pane?: boolean
  onClose?: () => void
  /** 子对话面板：父对话里点了它的结果卡片（时间戳），打开后滚到最后一份总结 */
  jumpSummary?: number
}) {
  const { agents: localAgents, workflows, settings, upsertTask, removeTask, projects: allProjects } = useData()
  const { tasks } = useTasks()
  const nav = useNav()
  const go: typeof nav.go = (r) => {
    embed?.onLeave()
    nav.go(r)
  }
  const [limit, setLimit] = useState(BLOCK_LIMIT)
  useEffect(() => setLimit(BLOCK_LIMIT), [taskId])
  // 对话数据：打开时取一份、建 SSE、往前翻页、已读和在场、加载日志（view/use-task-load.ts）
  const load = useTaskLoad({
    taskId,
    jumpMsg: nav.route.msg,
    tasks,
    upsertTask,
    onOlder: () => setLimit(Infinity),
  })
  const { task, setTask, apply, live, running, trace } = load
  // 导入的任务：本机没有的 Agent 用导入时带来的，名字照常显示
  const imported = task?.imported
  const agents = useMemo(() => withImportedAgents(localAgents, { imported }), [localAgents, imported])
  // 对话页顶层的弹窗（view/TaskDialogs.tsx）：开关都在这一份里，标题栏菜单、消息菜单、文件路径都往这里写
  const [dialogs, setDialogs] = useState<TaskDialogState>(NO_DIALOGS)
  const setDialog = useCallback(
    <K extends keyof TaskDialogState>(key: K, value: TaskDialogState[K]) => setDialogs((s) => ({ ...s, [key]: value })),
    [],
  )
  // 对话菜单「状态」（CLI 生命周期诊断）和「父子往来记录」（ADR 0034：默认不在右栏）
  const diag = useDiagDialogs(taskId)
  // 标题栏按钮和「更多操作」菜单是同一份清单，钉上的显示在标题栏（所有对话共用，见 HeaderPins）
  const pins = useHeaderPins()
  // 「对话进程」下拉：钉在标题栏时由它自己的按钮开关，没钉时从菜单打开，开关放在这一层
  const [procOpen, setProcOpen] = useState(false)
  // 没发出去的内容由 ChatComposer 自己按对话记着（切走再回来还在），打字时不再重渲染整页；
  // 这里只留一个「输入框是不是空的」，给「继续执行」按钮用，只在空 / 非空切换时更新
  const [draftEmpty, setDraftEmpty] = useState(true)
  const followTa = useRef<RichInputHandle>(null)
  // 和新建任务的输入框一样：可以附文件、粘贴截图、拖进来、输入 @ 引用项目文件
  const files = useAttachments(`task:${taskId}`)
  // Chat 页的对话没有项目：@ 在所有项目里一起搜
  const mention = useFileMention(project, followTa, files, task?.projectId ? [] : allProjects)
  const [panel, setPanel] = useState(false)
  // 子对话列表的状态和拉取（task-view-children.ts）
  const childList = useChildList()
  const { children, setChildren, loadChildren } = childList
  // 分析报告在哪条回复里：画在右侧的功能面板，不再铺在对话区（用户 2026-10-25 要求，ADR 0016）
  const report = useMemo(() => (task ? findReport(task) : null), [task])
  // 右栏开着哪个子对话、哪次运行，各个面板收没收（view/use-task-panes.ts）
  const panes = useTaskPanes({ taskId, pane, task, childList, reportId: report?.message.id ?? '' })
  const { openChild, openRun, paneRun, reportCover, setReportCover, openChildIn } = panes
  // 右栏打开的是子对话时，它在自己的 Provider 里读不到父对话的列表和跳转：
  // 这里在组件顶层取外层的值（Provider 之外），标题旁的切换下拉用它，不另取一份数据
  const outerChildren = useContext(ChildListCtx)
  const outerNav = useContext(PaneNavCtx)
  // 右栏页签条右端的工具区（ADR 0047）：给了就不画子对话自己的标题栏，按钮挂到那里
  const toolbarSlot = useContext(PaneToolbarCtx)
  const inToolbar = pane && !!toolbarSlot
  // 父对话和名下子对话之间的信（ADR 0034）：交代任务那行的回执、子对话面板里每个子对话的往来都读这一份。
  // 收件箱里还没读到的按子对话数：面板上写「n 封未读」
  const messages = task?.messages
  const inbox = task?.inbox
  const peerMail = useMemo<PeerMail>(() => {
    const unread = new Map<string, number>()
    for (const x of inbox ?? []) unread.set(x.from, (unread.get(x.from) ?? 0) + 1)
    return { letters: childLetters(messages ?? []), unread }
  }, [messages, inbox])
  // 对话加右栏这一整行的宽度：按它算会话栏放不放得下
  const [rowW, setRowW] = useState(0)
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!rowEl) return
    const ro = new ResizeObserver(() => setRowW(rowEl.clientWidth))
    ro.observe(rowEl)
    return () => ro.disconnect()
  }, [rowEl])
  // 左边空白不够放任务进度时（窄屏），从标题栏打开，浮在对话上面
  const [progressOpen, setProgressOpen] = useState(false)
  // 右栏自己这一栏：量拖动上限、量对半都以它为基准，不按全局第一个右栏（见 paneMax）
  const rail = useRef<HTMLElement>(null)
  // 右栏挂上没有要等任务加载完才知道：aside 挂上前 ref 是 null（useEffect 里那时读到的也是 null，
  // 量出来会是窗口估算值），所以用回调 ref 记下挂载时机，挂上之后再按真实容器对半
  const [railMounted, setRailMounted] = useState(false)
  const setRail = useCallback((el: HTMLElement | null) => {
    rail.current = el
    setRailMounted(!!el)
  }, [])
  // 这一行有多宽（右栏加中间的对话）：右栏默认宽度按它的一半算，每次现量（见 useHalfPane）
  const rowWidth = useCallback(() => rail.current?.parentElement?.clientWidth ?? 0, [])
  // 功能面板默认和中间对话对半（见 lib/pane-width.ts）；文件面板对半但最宽 FILES_PANE_CAP，右栏只是辅助。
  // 手动拖过之后按拖动后的宽度、双击拖动条也回到对半；上限至少留出中间 320
  // AI 分析窗口单独记一个宽度：对话页上拖宽过的文件面板不该把弹窗里的也撑宽
  const taskPanel = useHalfPane(
    embed ? 'ai-task-panel' : 'task-panel',
    PANE_MIN,
    () => Math.max(340, paneMax(rail.current, PANE_MIN)),
    rowWidth,
    railMounted,
    embed ? EMBED_FILES_PANE_CAP : FILES_PANE_CAP,
  )
  // 和文件面板并排在同一栏，但宽度偏好不同，各自记一个（共用 key 会互相改成对方拖过的宽度）
  const reportPane = useHalfPane(
    'report-panel',
    REPORT_PANE_MIN,
    () => paneMax(rail.current, REPORT_PANE_MIN),
    rowWidth,
    railMounted,
  )
  const [scrolled, setScrolled] = useState(false)
  useEscape(panel, () => setPanel(false))
  useEscape(progressOpen, () => setProgressOpen(false))
  // Agent 输出里点了文件路径：在弹窗里看文件内容
  const openFile = useCallback((path: string, line?: number) => setDialog('fileTarget', { path, line }), [setDialog])
  // Chat 页（没有项目的聊天）的右栏：从对话里抽出的代码、来源、附件，都没有时右栏开关禁用
  const chatRail = useChatRail(task?.messages ?? NO_MESSAGES)
  // 后台命令行的标题点了：在顶层打开这条命令的窗口。挂在页面顶层而不是运行区那一行里，
  // 命令跑完那一行会消失，窗口跟着行卸载的话用户正好看不到最终输出
  const openJob = useCallback((job: JobTarget) => setDialog('jobTarget', job), [setDialog])
  // 诊断报告的审阅弹窗同理：一轮输出完、子任务做完时打开它的那一行会重挂，弹窗只由用户关
  // 顶层对话页有并排的右栏：报告能停靠进去（分析稿 U7），右栏里的子对话、AI 窗口里嵌的只弹窗
  const bug = useDiagnosisHost(task, !pane && !embed)
  // CLI 真的在处理这一轮才算执行中；等下一句时页面按空闲显示
  const working = task?.working ?? false
  // 盖着文件面板时 Esc 先收面板，不弹停止确认
  useEscape(!!task?.working && !panel && !dialogs.stopAsk && !openRun && !paneRun, () => setDialog('stopAsk', true))
  const [view, setView] = useState<'chat' | 'flow'>('chat')
  // 流程图里选中的节点，右栏只看它
  const [flowSel, setFlowSel] = useState('')
  // 右栏「任务进度」里点了哪一步：切到流程视图并选中它，和点流程图的节点一样
  const [focus, setFocus] = useState<{ id: string; at: number }>()
  // 消息区的贴底：打开就在最新内容，流式输出、工具卡片展开、Markdown 变高都跟着走；
  // 用户往上翻时不打扰，回到底部附近再接着跟。切到流程图视图时这个容器不放对话，停止跟随
  const scroller = useConversationScroll(taskId, view === 'chat')
  // 输入框上方悬浮层的高度：消息流底部按它多留一段（见 FloatAbove）
  const [floatPad, setFloatPad] = useState(0)
  const { el: scrollerEl, pin: stickToBottom, unpin: stayPut } = scroller
  // 父对话点了结果卡片：滚到最后一份总结的标题（见 summary-jump.ts）
  useSummaryJump(scroller, jumpSummary, task?.id, task?.messages.length)
  // 拖文件的接收范围：对话页的主区域（消息流、状态行、子对话、输入框），右栏不在里面。
  // 用 state 存元素：ref 在首帧还是空的，effect 拿不到要监听的节点
  const [dropArea, setDropArea] = useState<HTMLElement | null>(null)
  // 消息下面的「引用」：像附件一样在输入框末尾放一张引用卡片，不把整段原文铺进输入框；
  // 原文跟着附件走，发出去后对话里还是这张卡片，交给 Agent 时才换成引用块
  useQuoteTarget(dropArea, (quoted) => {
    const ed = followTa.current
    if (!ed) return
    ed.focus()
    ed.setCaret(Number.MAX_SAFE_INTEGER)
    files.addQuote(quoted, {
      added: (items) => items.forEach((x) => ed.insertChip({ kind: x.kind, name: x.name })),
      failed: (name) => ed.setText(dropChip(ed.text(), name)),
    })
  })
  const [dropOver, setDropOver] = useState(false)

  // 子对话列表：首拉、轮询、推送信号（task-view-children.ts）
  useChildPolling(task, trace, childList)

  // 读屏用的状态播报：一轮做完、出错时说一句（画面上靠转圈和颜色，读屏用户看不到）。
  // 只在「执行中 → 停下」那一下更新，打开对话时不播报
  const [announce, setAnnounce] = useState('')
  const wasWorking = useRef(working)
  useEffect(() => {
    if (wasWorking.current && !working)
      setAnnounce(task?.status === 'failed' ? t('这一轮执行出错了') : t('这一轮执行完了'))
    wasWorking.current = working
    // 只跟着 working 变：status 在同一次推送里一起到
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [working])

  // 任务创建时存下的工作流；现在的版本改过时，可以选择按新的继续
  const workflow = task ? taskWorkflows(task, workflows).workflow : undefined
  const latestWf = workflows.find((w) => w.id === task?.workflowId)
  const wfChanged = !!task?.workflows.length && !!latestWf && latestWf.updatedAt !== workflow?.updatedAt
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  // 对话里派出的子任务：输入框上方的「子任务」栏里列出，点开看它的实时对话流；一个都没有时不画这条栏
  const helperIds = useMemo(() => (task ? chatHelperIds(task) : []), [task])
  // 「/」菜单：对话任务按现在用的 CLI 列命令和 Skill；工作流的节点都用默认 CLI，按它列，发出去时展开成普通的要求
  const slashAgent = task?.mode === 'chat' ? agents.find((a) => a.id === task.agentId) : undefined
  const slashCli =
    task?.mode === 'workflow'
      ? defaultCli(settings ?? defaultSettings())
      : slashAgent && task
        ? agentRun(withTaskModel(slashAgent, task), settings ?? defaultSettings()).cli
        : task?.mode === 'chat'
          ? defaultCli(settings ?? defaultSettings())
          : ''
  const slash = useSlashMenu({
    cli: slashCli,
    projectId: project?.id,
    // 压缩、审查是对话的操作，工作流里不提供
    scope: task?.mode === 'workflow' ? 'new' : 'task',
    // 草稿在输入框里，命令菜单清空 / 换内容时交给它
    setText: (v) => followTa.current?.setText(v),
    editor: followTa,
    onAction: (a, arg) => {
      if (!task) return
      if (running) return void toast.error(t('任务正在执行，请等它完成或先停止'))
      stickToBottom()
      ;(a === 'compact' ? api.compactTask(task.id) : api.reviewTask(task.id, arg))
        .then(apply)
        .catch((e) => toast.error((e as Error).message))
    },
  })
  // 点了就调接口的动作和它们自己的进行中状态（view/use-task-actions.ts）
  const act = useTaskActions({
    taskId,
    task,
    project,
    workflows,
    working,
    apply,
    setTask,
    lastTask: load.lastTask,
    files,
    taRef: followTa,
    slash,
    stickToBottom,
    upsertTask,
    removeTask,
    go,
    loadChildren,
    setChildren,
    closeDelete: () => setDialog('deleting', false),
  })
  // 总结卡「要你处理」的「处理」按钮：交给当前对话新的一轮（见 Markdown 的 HandleNeedsCtx）。
  // 给出去的函数保持不变，免得每次刷新都让所有回复重画；真正发送的那份每次渲染更新。
  // 「处理」按钮发的话不碰输入框：用户正在写的草稿和附件原样留着。
  // 执行中也照样发，和输入框一样由服务端决定插话还是排到这一轮结束后；工作流停住时处理完会接着走流程
  const needsRef = useRef<(text: string) => Promise<void>>(async () => {})
  needsRef.current = act.say
  const handleNeeds = useCallback((text: string) => needsRef.current(text), [])
  useEscape(reportCover, () => setReportCover(false), true)

  // 对话里要画的消息：服务端那份加上还没被服务端接收的（待认领）。其余地方读的还是服务端的 task
  const { pendingMsgs } = act
  const shownTask = useMemo(() => {
    if (!task || !pendingMsgs.length) return task
    const ids = new Set(task.messages.map((m) => m.id))
    const fresh = pendingMsgs.filter((m: TaskMessage) => !ids.has(m.id))
    return fresh.length ? { ...task, messages: [...task.messages, ...fresh] } : task
  }, [task, pendingMsgs])
  // 分段只在任务内容变了时重算：打字、开关面板不再把上千条消息重新归一遍
  const blocks = useMemo(() => (shownTask ? toBlocks(shownTask) : []), [shownTask])
  // 很长的任务先只画最后一部分，打开、刷新更快；往前看时再全部显示
  const hidden = Math.max(0, blocks.length - limit)
  // 运行区（子对话、后台命令）只挂在最新的一轮回复下面。不能直接认「最后一段」：
  // 刚发出的用户消息自己就是最后一段，那样运行区会在 AI 说出第一句话之前整块消失
  const latestTurn = useMemo(() => latestTurnIndex(blocks), [blocks])
  const shownBlocks = useMemo(() => blocks.slice(hidden), [blocks, hidden])
  // 轮次目录点一条：那一轮在更早没画出来的段里时先显示出来，画好后再按消息标记滚过去（见 message-anchor）
  const jumpToTurn = (msgId: string) => {
    const index = blocks.findIndex((b) => blockMsgIds(b).includes(msgId))
    if (index >= 0) setLimit((l) => Math.max(l, blocks.length - index))
    let tries = 0
    const attempt = () => {
      if (jumpToMessage(msgId) || ++tries >= ANCHOR_TRIES) return
      setTimeout(attempt, ANCHOR_RETRY_MS)
    }
    requestAnimationFrame(attempt)
  }

  // 插件给这个对话的右栏页签（ADR 0059）：放在提前返回之前，hook 每次渲染都要调到
  const pluginTabs = useTaskTabs(task ?? undefined)
  if (!task)
    return (
      <main className={cn('flex flex-1 items-center justify-center text-subtle', !pane && !embed && 'panel')}>
        <LoadTrace steps={trace.steps} />
      </main>
    )

  const pluginHome = pluginTabs.some((x) => x.home)
  // Chat 模式的聊天不属于项目：没有可看的项目文件，右边的文件栏和展开按钮都不显示。
  // 插件页签标了 home 的对话（例如模型设计的 3D 预览，不属于项目）照样要右栏放那个页签
  const noFiles = !task.projectId && !pluginHome
  // Chat 页的聊天换成自己的标题栏和右栏（Chat.dc.html）；项目里的对话照旧用页签条。
  // 聊天派出了子对话或开着运行页签时也退回页签条，那些页签要有地方放
  const chatPage = noFiles && !pane && !embed && task.mode === 'chat' && !children.length && !openRun
  // 这一轮没在跑时到底在等什么：等后台命令、等子任务、等工作流，还是真停在等下一句。
  // 统一用 shared/task 的 childWait（子对话栏、交给父对话的上报用的是同一个），不在这里另写一套
  // 「有没有东西在跑」——以前只看 awaitingUser，子任务还在跑也写「等待你的下一条消息」
  const chatWait =
    task.mode === 'chat' && live
      ? childWait(task, { background: live.jobs.length, cliAlive: live.cliAlive })
      : undefined
  // 子对话在右栏开一个页签（和项目文件、本对话改动并排），开着时右栏一定显示
  const childOn = !pane && !!openChild
  // 功能面板占右栏（宽屏）：和文件面板同一栏，同一时间只显示一个；开着子对话时先让给子对话
  const reportOn = !!report && !pane && !panes.reportFolded && !childOn && !bug.rail
  // 中间正显示运行页签（父对话藏起来）
  const showOther = !pane && !panes.onParent && openRun > 0
  // Chat 页（不属于项目）也有会话栏，只是不显示环境那些和项目有关的块（见 SessionBar 的 noProject）
  const sessionAllowed = !pane && !embed && !showOther
  // Chat 页的右栏（代码、来源、附件）：和项目对话的文件栏一样参与「并排放不放得下」
  const chatRailWanted = chatPage && panes.chatRailOn && !chatRail.empty && !reportOn && !reportCover
  const { sessionFits, sessionShown, filesYield, chatRailShown, filesHidden } = railLayout({
    rowW,
    sessionAllowed,
    sessionOpen: panes.sessionOpen,
    chatRailWanted,
    reportOn,
    reportW: reportPane.width,
    taskPanelW: taskPanel.width,
    childOn,
    bugRail: !!bug.rail,
    filesFolded: panes.filesFolded,
    noFiles,
    lastRail: panes.lastRail,
    pluginHome,
  })
  const closeReport = () => {
    if (reportCover) return setReportCover(false)
    panes.foldReport(true)
  }
  const reportPanel = report && (
    <AnalysisPanel
      task={task}
      project={project}
      kind={report.kind}
      text={report.message.text}
      onTask={apply}
      onClose={closeReport}
    />
  )

  // 执行中也能发：相关的要求会调整当前方向，交不出去的等这一轮结束后接着处理
  // 引入工作流只给项目里的父对话、而且角色能启动工作流（start_workflow 只给这样的父对话）；子对话不启动工作流
  const canPickFlow =
    !!task.projectId && !task.parentTaskId && task.mode !== 'workflow' && canStartFlow(localAgents, task.agentId)
  // 主流程的节点（不含主 Agent）；「都做完了」要连主 Agent 的整理一起算
  const tops = topSteps(task)
  const roots = task.steps.filter((s) => !s.parentId)
  const runningSteps = task.steps.filter((s) => s.status === 'running')
  const chatAgent = agents.find((a) => a.id === task.agentId)
  // 对话实际用的 CLI；Codex、Claude Code 能在执行中插话，Command Code 这类靠面板的工具取
  const chatCli = chatAgent
    ? agentRun(withTaskModel(chatAgent, task), settings ?? defaultSettings()).cli
    : task.mode === 'chat'
      ? // 不用角色的对话：服务端按对话自己选的 CLI 跑，没选按会话所在的 CLI，都没有才用默认 CLI（见 withTaskModel）
        task.cli || task.sessionCli || defaultCli(settings ?? defaultSettings())
      : ''
  // 工作流的节点收不了补充时，服务端会留给下一个节点，所以工作流总能补充
  const canSteer = working && (task.mode === 'workflow' || steerable(chatCli))
  // 不用角色的对话按 CLI 显示：署名是 CLI、模型和思考强度，输入框里随时能换
  const byCli = task.mode === 'chat' && !task.agentId
  const chatRun = { cli: task.cli || task.sessionCli || '', model: task.model, effort: task.effort }
  const chatLabel = (byCli ? getCli(chatCli)?.name : chatAgent?.name) || t('无角色')
  const mainAgent = agents.find((a) => a.id === workflow?.mainAgentId)
  const isFlow = task.mode === 'workflow' && view === 'flow'
  const flowNode = isFlow ? task.steps.find((s) => s.id === flowSel) : undefined
  // 点了任务进度里的某一步：切到流程图并定位到那一步
  const openStep =
    task.mode === 'workflow'
      ? (id: string) => {
          setPanel(false)
          // 流程视图里和点流程图的节点一样，选中它；对话视图里滚到这一步的输出，不切换视图
          if (view === 'flow') return setFocus({ id, at: Date.now() })
          const el = scrollerEl.current
          const sec = el?.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"]`)
          // 这一步在还没显示的较早内容里：先全部显示，画出来后再滚过去
          if (!sec && hidden) {
            setLimit(Infinity)
            return requestAnimationFrame(() => requestAnimationFrame(() => openStep?.(id)))
          }
          if (!el || !sec) return toast(t('这一步还没有输出'))
          // 定格在这一步：后面的输出不要再把它顶走
          stayPut()
          el.scrollTo({
            top: sec.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8,
            behavior: 'smooth',
          })
        }
      : undefined
  // 对话里的工作流卡片：和标题栏点「流程图」一样就地切到流程图，点了某个节点就在流程图里选中它
  const openFlow = (id?: string) => {
    setView('flow')
    if (scrollerEl.current) scrollerEl.current.scrollTop = 0
    if (id) setFocus({ id, at: Date.now() })
  }
  // 运行区那行「工作流」：工作流对话里和卡片一样切到流程图，普通对话（计划触发的运行）没有流程图，仍打开那次运行
  const runNav =
    task.mode === 'workflow' ? { runView: () => openFlow(), runTip: t('在流程图里查看') } : { runView: panes.openRunIn }
  // 工作流没走完时输入框上面有「继续流程」，输入框里就不再放「继续执行」
  const flowLeft = task.mode === 'workflow' && !running && flowUnfinished(task, workflow)
  const blocked = task.mode === 'workflow' ? blockedStep(task, taskFlow(task, workflow)) : undefined
  const failed = task.status === 'failed'
  const canResume = (failed || task.status === 'stopped') && draftEmpty && !flowLeft
  // 这一轮已说完、名下还有东西在跑（子对话 / 子任务 / 后台命令 / 工作流）：输入框只说「继续输入要求」
  // 会和旁边的停止按钮自相矛盾——用户看到的是「子对话在跑，父对话却停在等继续」。
  // 让它说清到底在等什么
  const waitText = !working ? liveWaitText(live) : ''
  const workflowName = task.mode === 'workflow' ? (workflow?.name ?? t('已删除的工作流')) : undefined

  // 导出、复制对话（task-view-actions.ts）
  const exports = taskExportActions(task)

  // 右边看某一次运行的实时输出时，输入框跟着挪到那个面板底下，不用关掉再看对话
  // 子对话请用户选择：和 Agent 的提问一样换掉输入框（Agent 自己的提问优先）
  const askOpen = (task.parentAsks ?? []).length > 0 && !task.imported && !asksQuestion(task.requests)
  // AI 分析窗口里嵌的分析对话：左侧对话区照设计稿 AiWindow 画（见 lib/ai-look.ts），普通对话页不受影响
  const aiLook = !!embed && isAnalysisTask(task, localAgents)
  // 已收尾（已解决）的子对话不给输入框：换成「已收尾 + 重新打开」一行，点了才重新出现输入框（用户 2026-10-31）
  const closedChild = !!task.parentTaskId && !!task.resolved && !task.imported
  const allDone = roots.every((s) => s.status === 'done')
  const composer = !task.imported && !closedChild && !asksQuestion(task.requests) && !askOpen && (
    <FollowComposer
      task={task}
      live={live}
      taskId={taskId}
      aiLook={aiLook}
      working={working}
      sending={act.sending}
      resuming={act.resuming}
      canSteer={canSteer}
      // 还在等名下的东西跑完时不放「继续执行」：再拉起一遍会和还在跑的子对话重复。只挡「已停止」：失败时「重试」要能点；
      // 用户亲手停的（user）也不挡：整棵树已经停了，服务端继续时会先等它们停稳（settleBefore），挡了就找不到继续入口
      showResume={!working && !(task.status === 'stopped' && waitText && task.stopReason !== 'user') && canResume}
      failed={failed}
      canPickFlow={canPickFlow}
      canMention={!!project?.path || (!task.projectId && allProjects.some((p) => p.path))}
      waitText={waitText}
      dropScope={isFlow ? null : dropArea}
      node={flowNode}
      files={files}
      mention={mention}
      slash={slash}
      taRef={followTa}
      byCli={byCli}
      chatRun={chatRun}
      chatAgent={chatAgent}
      flowHint={
        task.mode === 'workflow'
          ? flowHint({
              busy: working,
              failed,
              blocked,
              running: tops.filter((s) => s.status === 'running').length,
              allDone,
              mainName: mainAgent?.name ?? '',
            })
          : undefined
      }
      resumeTitle={task.mode === 'workflow' && !allDone ? t('从没完成的节点继续执行') : t('重新执行最后一条要求')}
      onEmptyChange={setDraftEmpty}
      onDropOver={setDropOver}
      send={act.send}
      stop={act.stop}
      resume={() => act.resume()}
      changeRun={act.changeRun}
      setTask={setTask}
      apply={apply}
    />
  )

  // 对话页的停靠区：计划、子对话、提醒和输入框（view/ConversationDock.tsx）
  const conversationDock = (
    <ConversationDock
      task={task}
      pane={pane}
      traceSteps={load.traceHidden ? trace.steps : undefined}
      kids={children}
      helperIds={helperIds}
      teamNames={teamNames}
      openChild={openChild}
      onOpenChild={openChildIn}
      onResumeChild={(id) => void act.resumeChild(id)}
      onAnswerChild={act.answerChild}
      onFloatHeight={setFloatPad}
      composer={composer}
      composerElsewhere={(showOther && !!openRun) || !!paneRun}
      askOpen={askOpen}
      closedChild={closedChild}
      flowLeft={flowLeft}
      blocked={blocked}
      resuming={act.resuming}
      onResume={() => act.resume()}
      onAnalyze={() => setDialog('analyzing', true)}
      projectName={project?.name}
      projectPath={project?.path}
      workflowName={workflowName}
      node={flowNode}
      inRail={sessionShown}
      apply={apply}
    />
  )

  // 标题区（面包屑、状态、标题）和操作按钮：父对话放进页签条（标题是父对话页签、按钮在页签条右端），
  // 中间打开的子对话沿用原来的标题栏（view/TaskHeader.tsx）
  const titleNode = <TaskTitle task={task} live={live} localAgents={localAgents} name={act.name} />
  // 标题栏的按钮和「更多操作」菜单是同一份清单（header-items、HeaderPins）：钉上的画在「更多操作」左边，没钉的只在菜单里
  const { items: headerItems, railButton } = taskHeaderItems({
    task,
    pane,
    family: !!task.parentTaskId || children.length > 0,
    reportTitle: report ? reportTitle(report.kind) : undefined,
    reportOn,
    reportCover,
    setReportCover,
    filesHidden,
    rail: !pane && !noFiles ? 'files' : chatPage ? 'chat' : null,
    chatRailEmpty: chatRail.empty,
    chatRailShown,
    sessionToggle: sessionAllowed && sessionFits,
    sessionShown,
    progress: task.mode === 'workflow' && tops.length > 0,
    progressOpen,
    setProgressOpen,
    procOpen,
    setProcOpen,
    busy: running && working,
    resumeLatest: !task.imported && wfChanged && (task.status === 'failed' || task.status === 'stopped'),
    canPopout: !pane && !embed && !task.imported && !task.parentTaskId,
    on: {
      settings: () => setDialog('convSettings', true),
      rename: () => act.name.setRenaming(task.title),
      exportIt: exports.exportIt,
      exportHtml: exports.exportHtml,
      copy: exports.copyIt,
      status: diag.openStatus,
      collab: diag.openCollab,
      analyze: () => setDialog('analyzing', true),
      forceStop: () => setDialog('forceAsk', true),
      resumeLatest: () => void act.resume(true),
      remove: () => setDialog('deleting', true),
      popout: () => {
        minimizeTask({ id: task.id, projectId: task.projectId || undefined })
        // 和 AI 窗口的“去对话里看”相反：收起后回上一级，不同时显示对话页和浮条
        go(minimizeBackRoute({ projectId: task.projectId || undefined }))
      },
      session: (v) => {
        panes.setSessionOpen(v)
        writeStored(SESSION_BAR_KEY, v ? '' : 'closed')
        if (v) panes.setLastRail('session')
        // 放不下时右侧那一栏是给会话栏让开、只是没显示：收起会话栏时一起记成收起，
        // 不然它会立刻补回原位，看起来像右边的面板没收起来（用户报「收起面板点击无效」）
        else if (filesYield) panes.toggleFiles()
        else if (chatRailWanted && !chatRailShown) panes.toggleChatRail()
      },
      reportWide: () => {
        if (reportOn) return closeReport()
        panes.foldReport(false)
      },
      // 宽屏右栏一直占着位置，这个按钮把文件面板收起来，让对话用满整个宽度
      filesWide: () => {
        panes.setLastRail('files')
        // 功能面板占着右栏：收起它换成文件
        if (reportOn) {
          panes.foldReport(true)
          if (panes.filesFolded) panes.toggleFiles()
          return
        }
        // 给会话栏让开了位置的：点了就换回文件，不是收起
        if (filesYield) return
        panes.toggleFiles()
      },
      filesCover: () => setPanel(true),
      chatRail: () => {
        panes.setLastRail('files')
        // 给会话栏让开了位置的：点了就换回右栏，不是收起
        if (chatRailWanted && !chatRailShown) return
        panes.toggleChatRail()
      },
    },
  })
  const headerActions = (
    <HeaderActions
      task={task}
      pane={pane}
      inToolbar={!!inToolbar}
      view={view}
      onView={(v) => {
        setView(v)
        // 切回对话视图由贴底自己停在最新一行；切到流程图时它把视图自己的滚动放在顶部
        if (v === 'flow' && scrollerEl.current) scrollerEl.current.scrollTop = 0
      }}
      resolving={act.resolving}
      onResolve={() => void act.resolveChild()}
      items={headerItems}
      isPinned={pins.isPinned}
      setPinned={pins.setPinned}
      procOpen={procOpen}
      setProcOpen={setProcOpen}
      railButton={railButton}
      extra={embed?.actions}
    />
  )
  const badgesAndActions = (
    <>
      <HeaderBadges task={task} />
      {headerActions}
    </>
  )
  // 一轮回复里的「答复」类按钮、教训弹窗交给角色整理：不碰输入框直接发一句
  const say = act.say

  return (
    <WithAgents agents={agents}>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
      <TaskViewCtx
        taskId={task.id}
        projectId={task.projectId}
        openFile={openFile}
        aiLook={aiLook}
        handleNeeds={task.imported ? null : handleNeeds}
        cards={!task.parentTaskId}
      >
        {/* 子对话（右栏面板或单独打开）里点「启动工作流」：就地换成这次运行的视图，下面带着输入框 */}
        <PaneNavCtx.Provider
          value={
            pane || task.parentTaskId
              ? { runTool: panes.openPaneRun, ...runNav, ...bug.nav, openChild, job: openJob }
              : {
                  child: panes.openChildRow,
                  childSummary: panes.openChildSummary,
                  ...runNav,
                  ...bug.nav,
                  openChild,
                  job: openJob,
                }
          }
        >
          <ChildMailProvider kids={children} mail={peerMail}>
            <div
              ref={setRowEl}
              className={cn(
                'relative flex min-w-0 flex-1',
                pane ? 'h-full min-h-0' : 'min-h-[70vh] md:h-full md:min-h-0',
              )}
            >
              <main
                ref={setDropArea}
                className={cn('relative flex min-w-0 flex-1 flex-col bg-bg md:h-full', !pane && !embed && 'panel')}
              >
                {/* 打开对话的加载日志：数据到了先盖在对话上，走完停一会儿再淡出（不挡下面的对话） */}
                {!load.traceHidden && <LoadTrace overlay steps={trace.steps} onHidden={load.hideTrace} />}
                {/* 从外面把文件拖到对话页任何位置都算引入到要求里；右栏和流程图有自己的拖拽语义，不在范围内 */}
                {dropOver && <DropOverlay />}
                {chatPage ? (
                  <ChatHeader
                    task={task}
                    live={live}
                    scrolled={scrolled}
                    title={titleNode}
                    roleLabel={byCli ? undefined : chatLabel}
                    exports={exports}
                    actions={headerActions}
                  />
                ) : inToolbar ? (
                  // 右栏里的子对话（ADR 0047）：状态和标题在页签上，按钮挂到页签条右端的工具区，不再画一行标题栏
                  createPortal(badgesAndActions, toolbarSlot!)
                ) : pane ? (
                  <header
                    className={cn(
                      // group/hdr：标题栏右侧的「解决」按钮默认隐起来，鼠标进到标题栏或 Tab 聚焦时才显示
                      'group/hdr flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-colors md:px-5',
                      scrolled ? 'border-line' : 'border-transparent',
                    )}
                  >
                    <HeaderNav
                      task={task}
                      live={live}
                      pane={pane}
                      outerChildren={outerChildren}
                      outerNav={outerNav}
                      title={titleNode}
                    />
                    {headerActions}
                  </header>
                ) : embed?.slot && !showOther ? (
                  createPortal(badgesAndActions, embed.slot)
                ) : (
                  <ConversationTabs
                    task={task}
                    runName={task.workflowName || workflow?.name}
                    openRun={openRun}
                    front={showOther ? 'other' : 'parent'}
                    renaming={act.name.renaming}
                    onRenaming={act.name.setRenaming}
                    onRename={act.name.rename}
                    onParent={() => panes.setOnParent(true)}
                    onOther={() => panes.setOnParent(false)}
                    onCloseRun={() => panes.openRunIn(0)}
                    mark={isAnalysisTask(task, localAgents) ? <AnalysisMark kind={task.analysis} /> : undefined}
                    trailing={badgesAndActions}
                  />
                )}

                {/* 父对话本身：中间换成子对话或运行页签时只是藏起来，切回来滚动位置、输入框里的字都还在 */}
                {/* data-scroll-pair：对话正文和会话栏的滚动条共用右边一条槽，鼠标在哪块显示哪块的（见 RailScrollbar） */}
                <div data-scroll-pair className={cn('relative flex min-h-0 flex-1', showOther && 'hidden')}>
                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    <ConversationShell
                      scroller={scroller}
                      floatPad={floatPad}
                      overlay={
                        <>
                          {progressOpen && (
                            <div className="absolute top-3 left-3 z-20 w-[min(340px,calc(100%-1.5rem))] md:left-4">
                              <TaskPanel task={task} onStep={openStep} className="shadow-pop" />
                            </div>
                          )}
                          {/* 右上角的轮次导航：没有会话栏时让出滚动条（12px），有会话栏时贴着会话栏左边 */}
                          {!isFlow && (
                            <TurnRail
                              msgs={task.messages}
                              scrollEl={scroller.el}
                              onJump={jumpToTurn}
                              right={sessionShown ? SESSION_BAR_W + RAIL_GUTTER + 4 : 14}
                            />
                          )}
                        </>
                      }
                      // 流程图视图自己管滚动：上面的流程图固定，只有下面的节点输出滚动
                      fill={
                        isFlow ? (
                          <Suspense fallback={null}>
                            <TaskFlow
                              task={task}
                              focus={focus}
                              onSelect={setFlowSel}
                              onOpenChat={() => {
                                setView('chat')
                              }}
                            />
                          </Suspense>
                        ) : undefined
                      }
                      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
                      // 段落（用户消息、一轮回复）之间 20px（设计稿 16–20px），比默认的 28px 紧凑
                      contentClassName="gap-5"
                      dock={conversationDock}
                      // 会话栏浮在右边（下面的 aside）：消息和输入框让出它的宽度，滚动条留在最右边
                      rail={sessionShown ? SESSION_BAR_W + RAIL_GUTTER : 0}
                    >
                      {(hidden > 0 || task.messageHasMore) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={load.earlierLoading}
                          onClick={() => (task.messageHasMore ? void load.loadEarlier() : setLimit(Infinity))}
                          className="self-center rounded-full text-xs font-normal text-muted"
                        >
                          {task.messageHasMore ? t('显示更早的消息') : t('显示更早的 {n} 段', { n: hidden })}
                        </Button>
                      )}
                      <RouteProvider
                        task={task}
                        send={async (text) => apply(await api.sendMessage(task.id, text, [], false))}
                      >
                        <TaskMessages
                          ctx={{
                            task,
                            shown: shownBlocks,
                            hidden,
                            total: blocks.length,
                            latestTurn,
                            working,
                            running,
                            teamNames,
                            fallback: byCli ? chatRun : undefined,
                            firstUser: task.messages.find((m) => m.role === 'user')?.id,
                            localAgents,
                            hasProject: !!project,
                            workflowName: workflow?.name,
                            apply,
                            stickToBottom,
                            resend: act.resend,
                            fork: act.fork,
                            onRewind: (id) => setDialog('rewindAsk', id),
                            onLesson: (text) => setDialog('lessonOf', text),
                            openRun: panes.openRunIn,
                            openFlow,
                          }}
                        />
                      </RouteProvider>
                      {running &&
                        task.mode === 'chat' &&
                        working &&
                        (blocks.at(-1)?.kind === 'turn' ? (
                          <div className="flex items-center gap-2 text-body text-muted">
                            <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                            <RunPhase
                              task={task}
                              label={t('{name} 正在回复', { name: chatLabel })}
                              agentIds={[task.agentId]}
                              onStatus={diag.openStatus}
                            />
                            <LiveStats task={task} agentIds={[task.agentId]} />
                          </div>
                        ) : (
                          // 发出消息、还没有输出时就显示是谁在回复、用的哪个模型，不用等第一段输出
                          <PendingReply fallback={byCli ? chatRun : undefined} agentId={task.agentId}>
                            <div className="flex items-center gap-2 text-body text-muted">
                              <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                              <RunPhase
                                task={task}
                                label={t('思考中…')}
                                agentIds={[task.agentId]}
                                onStatus={diag.openStatus}
                              />
                              <LiveStats task={task} agentIds={[task.agentId]} />
                            </div>
                          </PendingReply>
                        ))}
                      {/* 这一轮没在跑时先说清在等什么：等后台命令、等派出的子任务、等工作流，最后才是真的停在等下一句。
                      以前只看 awaitingUser 就写「等待你的下一条消息」，子任务还在跑时也这么说
                      （用户报的：子任务在跑、状态行却说在等你 + 空闲）。判定统一用 childWait，不另写一套 */}
                      {running && task.mode === 'chat' && !working && chatWait && (
                        <ChatWaitLine
                          wait={chatWait}
                          awaiting={task.awaitingUser}
                          task={task}
                          onStatus={diag.openStatus}
                        />
                      )}
                      {working && task.mode === 'workflow' && runningSteps.length === 0 && (
                        <div className="flex items-center gap-2 text-body text-muted">
                          <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                          <RunPhase
                            task={task}
                            label={t('{name} 正在处理', { name: mainAgent?.name ?? t('主角色') })}
                          />
                          <LiveStats task={task} />
                        </div>
                      )}
                      {/* CLI 还没取走的消息已经直接进对话，这里不用再放一份 */}
                    </ConversationShell>
                  </div>
                  {/* 会话栏在对话右边、同一块面板里（照 Claude Code），不占右侧的文件栏。
                      固定浮在右边、不跟着消息滚：消息区的滚动容器铺满到最右，滚动条在它右边那一条（RAIL_GUTTER）里 */}
                  {sessionShown && (
                    <aside
                      aria-label={t('会话栏')}
                      data-session-rail
                      style={{ width: SESSION_BAR_W, right: RAIL_GUTTER }}
                      // 和对话之间一道细线分开（照 Claude Code 的功能区），不再是浮着的圆角卡片
                      className="absolute inset-y-0 z-10 flex flex-col border-l border-line bg-bg"
                    >
                      <SessionBar
                        task={task}
                        projectName={project?.name}
                        onTask={apply}
                        kids={children}
                        noProject={noFiles}
                        railGutter={RAIL_GUTTER}
                        env={
                          <EnvChip
                            compact
                            task={task}
                            projectName={project?.name}
                            projectPath={project?.path}
                            workflowName={workflowName}
                            onOpenChild={openChildIn}
                          />
                        }
                        onSettings={
                          task.projectId && !task.parentTaskId && task.mode === 'chat' && !task.imported
                            ? () => setDialog('convSettings', true)
                            : undefined
                        }
                      />
                    </aside>
                  )}
                </div>
                {/* 中间的运行页签：这一次工作流运行的节点和实时输出，底下带着输入框 */}
                {!pane && showOther && openRun > 0 && (
                  <RunPanel
                    task={task}
                    run={openRun}
                    name={task.workflowName || workflow?.name}
                    onClose={() => panes.openRunIn(0)}
                    footer={composer}
                  />
                )}
                {/* 子对话里点开的一次运行：盖在这块面板上，子对话本身不卸载，返回后滚动位置原样保留。
                    返回（←）回子对话这一层，✕ 走 onClose 关掉子对话面板本身。
                    输入框跟着放在运行视图底下，和父对话右栏的运行面板一样，看着节点也能补充要求 */}
                {/* 子对话面板里没有地方并排：功能面板盖在对话上，收起后对话原样回来 */}
                {pane && reportCover && reportPanel && (
                  <div className="absolute inset-0 z-30 flex flex-col">{reportPanel}</div>
                )}
                {paneRun && (
                  <RunView
                    task={task}
                    run={paneRun.run}
                    tool={paneRun.tool}
                    tab={paneRun.tab}
                    onBack={() => panes.setPaneRun(null)}
                    onClose={onClose}
                    footer={composer}
                  />
                )}
              </main>

              <TaskSideRail
                task={task}
                pane={pane}
                embed={!!embed}
                projectPath={project?.path}
                panel={panel}
                closePanel={() => setPanel(false)}
                reportOn={reportOn}
                reportCover={reportCover}
                closeReportCover={() => setReportCover(false)}
                reportTitle={report ? reportTitle(report.kind) : undefined}
                reportPanel={reportPanel}
                reportPane={reportPane}
                taskPanel={taskPanel}
                railRef={setRail}
                filesHidden={filesHidden}
                noFiles={noFiles}
                node={flowNode}
                report={bug.rail}
                childOn={childOn}
                openChild={openChild}
                kids={children}
                ownedIds={panes.ownedIds}
                childSummaryAt={panes.childSummaryAt}
                closeChild={() => openChildIn('')}
                childView={
                  childOn && (
                    <TaskView
                      key={openChild}
                      taskId={openChild}
                      project={project}
                      pane
                      onClose={() => openChildIn('')}
                      jumpSummary={panes.childSummaryAt}
                    />
                  )
                }
                chatRailShown={chatRailShown}
                chatRail={chatRail}
                openLocalFile={(path) => setDialog('fileTarget', { path, local: true })}
                apply={apply}
              />
            </div>
            <TaskDialogs
              task={task}
              project={project}
              localAgents={localAgents}
              working={working}
              state={dialogs}
              set={setDialog}
              stop={act.stop}
              forceStop={act.forceStop}
              remove={act.remove}
              // 对话里的角色知道刚才哪里做错了，交给它整理
              askAgent={(message) => say(message)}
              onRewound={(r) => {
                apply(r.task)
                followTa.current?.setText(r.text)
                // 那条消息的图片、文件、引用一起放回来：卡片已经在文字里
                files.replace(r.attachments ?? [])
                followTa.current?.focus()
              }}
              apply={apply}
              more={
                <>
                  {bug.dialog}
                  {diag.dialogs(task.parentTaskId ? outerNav?.child : openChildIn)}
                </>
              }
            />
          </ChildMailProvider>
        </PaneNavCtx.Provider>
      </TaskViewCtx>
    </WithAgents>
  )
}

/**
 * 对话页往下传的两个上下文：点文件路径打开文件窗口、AI 分析窗口的样式（lib/ai-look.ts）。
 * 合成一个组件是为了不在 TaskView 的大段 JSX 外面再套一层（套一层整段都要重新缩进）
 */
function TaskViewCtx({
  taskId,
  projectId,
  openFile,
  aiLook,
  handleNeeds,
  cards,
  children,
}: {
  taskId: string
  projectId?: string
  openFile: (path: string, line?: number) => void
  aiLook: boolean
  handleNeeds: ((text: string) => Promise<void>) | null
  /** 子对话里总结照普通 Markdown 显示，不画卡片（见 Markdown 的 SummaryCardsCtx） */
  cards: boolean
  children: React.ReactNode
}) {
  return (
    <FileOpenCtx.Provider value={openFile}>
      <FileRefLayer taskId={taskId} projectId={projectId} preview={openFile}>
        <AiLookCtx.Provider value={aiLook}>
          <HandleNeedsCtx.Provider value={handleNeeds}>
            <SummaryCardsCtx.Provider value={cards}>{children}</SummaryCardsCtx.Provider>
          </HandleNeedsCtx.Provider>
        </AiLookCtx.Provider>
      </FileRefLayer>
    </FileOpenCtx.Provider>
  )
}
