import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { expandQuotes, useQuoteTarget } from '@/lib/quote'
import { toast } from 'sonner'
import {
  ArrowRight,
  ChevronRight,
  CheckCircle2,
  FlaskConical,
  GitBranch,
  GitFork,
  GitMerge,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  Undo2,
  Pencil,
  RotateCw,
  Trash2,
  X,
  ListPlus,
  ArrowDown,
  Workflow as WorkflowIcon,
  Download,
  FileInput,
  Sparkles,
  Settings2,
  GraduationCap,
  CircleStop,
  MessageCircleQuestion,
  Copy,
} from 'lucide-react'
import { ConversationSettingsDialog } from './ConversationSettingsDialog'
import { ProcessMenu } from './ProcessPanel'
import { HelperBar } from './HelperCards'
import { type Project, type StopReason, type Task, type TaskMessage, type TaskStep, type ToolUse } from '@shared/schema'
import { ChatModelPicker, useChatRun, useRunAuthor, type ChatRun } from './ChatModelPicker'
import { blockedStep, flowUnfinished, MAIN_STEP, rootStepId, taskFlow, taskWorkflows, topSteps } from '@shared/flow'
import {
  childIcon,
  childStale,
  childStage,
  childWaitText,
  runningChildren,
  sortChildren,
  stopReasonText,
  taskBusy,
  taskSummary,
  withTaskModel,
  type ChildActivity,
  type ChildWait,
  type TaskStage,
} from '@shared/task'
import { agentRun, defaultCli, defaultSettings } from '@shared/settings'
import { getCli, steerable } from '@shared/clis'
import { api } from '@/lib/api'
import { useTaskStream } from '@/lib/task-stream'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { plainLine, startedRun, toolVerb, toolView } from '@/lib/tasks'
import { WithAgents, useData, useNav } from '@/lib/data'
import { downloadTask } from '@/lib/task-transfer'
import { withImportedAgents } from '@shared/task-export'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { STICK_THRESHOLD, useStickToBottom } from '@/lib/useStickToBottom'
import { AgentMessage, ChatReply, NoteMessage, PendingAuthor } from './Messages'
import { useAgentView } from '@/lib/agent-view'
import { LiveStats } from './LiveStats'
import { NextWorkflows } from './NextWorkflows'
import { AnalyzeDialog, EvolutionCard } from './Evolution'
import { StepSection } from './StepSection'
import { RunCard, RunPanel } from './RunCard'
import { RunView } from './RunView'
import { TaskPanel } from './TaskPanel'
import { PlanButton } from './PlanPanel'
import { TaskMeta } from './TaskMeta'
import {
  DeleteTaskDialog,
  WorktreeMark,
  needsMerge,
  useWorktreeActions,
  useWorktrees,
  worktreeKey,
  worktreeSummary,
} from './Worktrees'
import { TaskFiles } from './TaskFiles'
import { FileDialog, FileOpenCtx } from './FileDialog'
import { ChildListCtx, PaneNavCtx } from './child-open'
import { FoldedAskBar, ParentAskPanel } from './ChildAskCard'
import { TaskRequestCard, asksQuestion } from './RequestCard'
import { useSlashMenu } from '@/components/chat/SlashMenu'
import { AskToggle } from '@/components/chat/AskToggle'
import { StepIcon, TaskStatusIcon } from './TaskStatusIcon'
import { ATTACHMENT_PROMPT, DropOverlay, useAttachments, useFileMention } from '@/components/chat/Attachments'
import { ChatComposer } from '@/components/chat/ChatComposer'
import type { RichInputHandle } from '@/components/chat/RichInput'
import { dropChip, forSend, pathText } from '@shared/composer'
import { UserMessage, msgAction } from '@/components/chat/ChatMessage'
import { RecordLessonDialog } from '@/components/projects/Lessons'

/** 流程图视图用到的画布库比较大，切到流程图时才加载 */
const TaskFlow = lazy(() => import('./TaskFlow').then((m) => ({ default: m.TaskFlow })))

type Block =
  | { kind: 'msg'; m: TaskMessage }
  /** 对话里 Agent 连续的回复（一轮），完成后折叠过程 */
  | { kind: 'turn'; key: string; msgs: TaskMessage[] }
  | { kind: 'steps'; key: string; roots: string[]; byRoot: Map<string, TaskMessage[]> }
  /** 工作流的一次运行：节点输出去右边的面板里看 */
  | { kind: 'run'; key: string; run: number }

/** 以前新建子对话时记的系统提示（中文、英文界面各一种写法） */
const OLD_CREATED =
  /^(新建了子对话「.*」，这条消息交给它处理|Created sub-conversation “.*”; this message is handed to it)$/

/** 以前子对话做完后在父对话里记的通知，和居中显示的汇报、提问（现在汇报只给 AI，提问是卡片） */
const OLD_CHILD_NOTE = /^子对话「[^」]*」(已完成|失败|已停止|合并编译通过|合并编译没通过|汇报：|提问：)/

/** 以前开独立分支时记的居中提示：现在 begin_edit 这次调用本身显示成「开独立分支 分支名」 */
const OLD_WORKTREE = /^(要改文件了，已开独立分支 |Ready to edit files: opened separate branch )/

/** 这条消息属于第几次运行（节点 id 带 `r2/` 前缀的算第 2 次） */
function runOf(step: string) {
  const m = /^r(\d+)\//.exec(step)
  return m ? Number(m[1]) : 1
}

/**
 * 把消息分段：连续的节点输出归到一段，段里再按主流程节点分开，同时执行的节点输出不会交错。
 * 工作流任务（主 Agent 是编排器）里节点输出不铺在对话里，按运行归成一张卡片
 */
function toBlocks(task: Task): Block[] {
  const blocks: Block[] = []
  const msgs = task.messages
  // 有工作流运行的对话：一次运行一张卡片，没有单独的节点段。节点输出不铺在对话里，
  // 按「第一次出现这次运行」的位置放卡片，后面的节点消息都跳过
  const byRun = task.mode === 'workflow' || (task.runs?.length ?? 0) > 0
  const carded = new Set<number>()
  // 往后找第一条带节点的消息：判断这条用户消息后面还有没有同一个节点的输出
  const nextRoot = (from: number) => {
    for (let i = from; i < msgs.length; i++) if (msgs[i].step) return rootStepId(msgs[i].step)
    return undefined
  }
  // 对话里派出的子角色：它们的输出收进派出时那张子任务卡片，不平铺在父对话里打断父对话的回复
  const helpers = byRun ? [] : msgs.flatMap((m) => m.spawned ?? [])
  const inHelper = (step: string) => helpers.some((id) => step === id || step.startsWith(`${id}/`))
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.step && helpers.length && inHelper(m.step)) continue
    // 旧对话里新建子对话时记的居中提示：现在这次工具调用本身就显示成「新建子对话 标题」，不再重复
    if (m.role === 'system' && !m.step && OLD_CREATED.test(m.text)) continue
    // 子对话交回父对话的回报只给父对话的 AI 看：做完了看子对话栏和列表里的绿勾（旧数据没有标记，按文字认）
    if (m.role === 'system' && !m.step && (m.panel === 'child' || (!m.panel && OLD_CHILD_NOTE.test(m.text)))) continue
    if (m.role === 'system' && !m.step && !m.panel && OLD_WORKTREE.test(m.text)) continue
    // 派出的子任务、面板推回的结果（后台命令、合并编译、子任务结果）都是 AI 这一轮回复里的一行，
    // 归进当前这轮回复，不单独成段，也不显示成用户消息
    if (!m.step && ((!byRun && m.spawned?.length) || m.panel)) {
      const b = blocks.at(-1)
      if (b?.kind === 'turn') b.msgs.push(m)
      else blocks.push({ kind: 'turn', key: m.id, msgs: [m] })
      continue
    }
    // 没有节点的用户消息（对话里、工作流外的追加要求）单独成一段；
    // 执行中补发的要求后面还有同一个节点的输出时，留在那个节点的竖线里，不另起一段
    if (m.role === 'user' && !m.step) {
      const b = blocks.at(-1)
      const root = b?.kind === 'steps' ? b.roots.at(-1) : undefined
      if (!byRun && b?.kind === 'steps' && root && nextRoot(i + 1) === root) {
        b.byRoot.get(root)!.push(m)
        continue
      }
      blocks.push({ kind: 'msg', m })
      continue
    }
    // 主 Agent 自己的会话（编排器，`@main` 或委派里的 `<父节点>/…/@main`）留在对话里，不属于任何一次运行
    if (!m.step || m.step.endsWith(MAIN_STEP)) {
      // 对话里 Agent 连续的回复归到一轮
      if (m.role === 'agent') {
        const b = blocks.at(-1)
        if (b?.kind === 'turn') b.msgs.push(m)
        else blocks.push({ kind: 'turn', key: m.id, msgs: [m] })
      } else blocks.push({ kind: 'msg', m })
      continue
    }
    if (byRun) {
      // 同一个运行的节点输出只在第一次出现时放一张卡片，其余的都去卡片里看
      const run = runOf(m.step)
      if (carded.has(run)) continue
      carded.add(run)
      blocks.push({ kind: 'run', key: `run${run}`, run })
      continue
    }
    let b = blocks.at(-1)
    if (b?.kind !== 'steps') {
      b = { kind: 'steps', key: m.id, roots: [], byRoot: new Map() }
      blocks.push(b)
    }
    const root = rootStepId(m.step)
    if (!b.byRoot.has(root)) (b.roots.push(root), b.byRoot.set(root, []))
    b.byRoot.get(root)!.push(m)
  }
  // 正在执行但还没有输出的节点也显示出来
  if (task.status === 'running') {
    const running = task.steps.filter((s) => !s.parentId && s.status === 'running' && s.kind !== 'main')
    if (byRun) {
      // 运行开始执行、还没有任何输出时也要有一张卡片
      for (const s of running) {
        const run = runOf(s.id)
        if (carded.has(run)) continue
        carded.add(run)
        blocks.push({ kind: 'run', key: `run${run}-live`, run })
      }
    } else {
      let b = blocks.at(-1)
      if (running.length && b?.kind !== 'steps') {
        b = { kind: 'steps', key: 'live', roots: [], byRoot: new Map() }
        blocks.push(b)
      }
      if (b?.kind === 'steps')
        for (const s of running) if (!b.byRoot.has(s.id)) (b.roots.push(s.id), b.byRoot.set(s.id, []))
    }
  }
  return blocks
}

/** 一个任务的对话页：上方是执行输出，下方继续输入要求，右侧是进度、上下文和更改 */
/** project 为空时是 Chat 模式的聊天，不属于任何项目 */
/** 任务页一开始最多画多少段（一个节点组、一轮对话算一段） */
const BLOCK_LIMIT = 30

/**
 * 内容没变就沿用原来的数组：子对话栏 4 秒轮询一次，每次都换新数组会让整个对话页（连同几百条消息）重渲染，
 * 子对话一多、消息一长，打字和滚动都会跟着一顿一顿的
 */
function sameJson<T>(cur: T, next: T): T {
  return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
}

/** 父对话里的子对话入口：标题、状态、最近结果 */
interface ChildSummary {
  id: string
  title: string
  status: Task['status']
  summary: string
  working: boolean
  updatedAt: string
  /** 进程还活着（预热、等下一句、正在执行） */
  cliAlive: boolean
  /** 本次开启的时间（最近一轮开始执行），列表按它排序 */
  startedAt: string
  /** 正在等用户确认的请求数 */
  requests?: number
  /** 还没做完的计划进度：有它就不算已完成，行上显示「计划 7/8」；带上正在做的那一步 */
  plan?: { done: number; total: number; step?: string; child?: string }
  /** 还在跑、排队的后台命令数：有它就算还在执行（见 shared/task.ts 的 childRunning） */
  background?: number
  /** 工作流运行还没跑完：也是还在执行 */
  workflow?: boolean
  /** 派出的子任务还在跑：也是还在执行 */
  helpers?: boolean
  /** 独立分支还没合回父对话的分支：不算彻底完成，归「未完成」 */
  unmerged?: boolean
  /** 请用户选择、还没人回答的提问数 */
  asking?: number
  /** 在独立 worktree 里改时的分支 */
  branch?: string
  /** 用户标记了「解决」：归到「已完成」并带标记 */
  resolved?: boolean
  /** 正在执行时这会儿在做什么 */
  activity?: ChildActivity
  /** 最后有动静的时间：执行中几分钟没新输出时标黄 / 标红（见 childStale） */
  lastActivityAt?: string
  /** 这会儿在等什么（不是在跑也不是卡住）：等用户回答、等后台命令、等子任务 */
  waiting?: ChildWait
  /** 停在 stopped 的原因：/children 直接给；演示后端没有这一项时单独取（见 loadChildren） */
  stopReason?: StopReason
}

/** 子对话那一行下面的说明：执行中写正在做什么，其余写它在等什么或最近结果 */
function childNote(c: ChildSummary, running: boolean) {
  const doing = activityText(c.activity)
  const plan = c.plan?.step || c.plan?.child
  return running ? [doing, plan].filter(Boolean).join(' · ') : childWaitText(c.waiting) || c.summary
}

/**
 * 执行中但是很久没有新输出：标黄 / 标红，父对话不用拿分支时间戳猜它是不是卡住了。
 * 等后台命令、等用户这类能解释的等待不算（见 shared/task.ts 的 childStale）
 */
function staleLine(c: ChildSummary) {
  const level = childStale({ working: c.working, wait: c.waiting, lastActivityAt: c.lastActivityAt })
  if (!level || !c.lastActivityAt) return undefined
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(c.lastActivityAt)) / 60000))
  return { text: t('已 {n} 分钟没有新输出', { n: mins }), cls: level === 'stale' ? 'text-danger' : 'text-warning' }
}

/** 子对话这会儿在做什么，一句话：跑的节点、等的子任务、正在用的工具或正在说的话 */
function activityText(a: ChildActivity | undefined) {
  if (!a) return ''
  if (a.steps?.length) return a.steps.join(t('、'))
  if (a.tool) {
    // 面板工具、MCP 工具按对话里显示的说法（开独立分支 xxx），不是「MCP panel-xxxx · begin_edit」
    const v = toolView({ ...a.tool, detail: '' })?.tool ?? { ...a.tool, detail: '' }
    return `${toolVerb(v)} ${v.label}`.trim()
  }
  if (a.helpers?.length) return t('等待子任务：{list}', { list: a.helpers.join(t('、')) })
  if (a.text) return plainLine(a.text)
  return t('正在思考…')
}

/** 右栏开着哪个子对话按父任务 id 记在本地：切走窗口、重新加载后还显示原来那个 */
const paneChildKey = (taskId: string) => `task-child:${taskId}`
const paneRunKey = (taskId: string) => `task-run:${taskId}`

function readStored(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStored(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // 隐私模式禁用本地存储时只是不记住，不影响使用
  }
}

const readPaneChild = (taskId: string) => readStored(paneChildKey(taskId))
const readPaneRun = (taskId: string) => Number(readStored(paneRunKey(taskId))) || 0
function writePaneChild(taskId: string, childId: string) {
  writeStored(paneChildKey(taskId), childId)
  // 子对话和运行面板互斥：右栏同一时间只显示一个
  if (childId) writeStored(paneRunKey(taskId), '')
}
function writePaneRun(taskId: string, run: number) {
  writeStored(paneRunKey(taskId), run ? String(run) : '')
  if (run) writeStored(paneChildKey(taskId), '')
}

export function TaskView({
  taskId,
  project,
  embed,
  pane,
  onClose,
}: {
  taskId: string
  project?: Project
  /** 放在弹窗里（例如「AI 处理」）：标题栏右边加上弹窗自己的按钮；要跳到别的页面时先收起弹窗 */
  embed?: { actions: React.ReactNode; onLeave: () => void }
  /** 放在对话页右侧的子对话栏里：不画自己的右栏，标题栏加上关闭按钮 */
  pane?: boolean
  onClose?: () => void
}) {
  const { agents: localAgents, workflows, settings, upsertTask, removeTask } = useData()
  const nav = useNav()
  const go: typeof nav.go = (r) => {
    embed?.onLeave()
    nav.go(r)
  }
  const [task, setTask] = useState<Task | null>(null)
  // 导入的任务：本机没有的 Agent 用导入时带来的，名字照常显示
  const imported = task?.imported
  const agents = useMemo(() => withImportedAgents(localAgents, { imported }), [localAgents, imported])
  const [analyzing, setAnalyzing] = useState(false)
  const [convSettings, setConvSettings] = useState(false)
  // 没发出去的内容由 ChatComposer 自己按对话记着（切走再回来还在），打字时不再重渲染整页；
  // 这里只留一个「输入框是不是空的」，给「继续执行」按钮用，只在空 / 非空切换时更新
  const [draftEmpty, setDraftEmpty] = useState(true)
  const followTa = useRef<RichInputHandle>(null)
  // 和新建任务的输入框一样：可以附文件、粘贴截图、拖进来、输入 @ 引用项目文件
  const files = useAttachments(`task:${taskId}`)
  const mention = useFileMention(project?.id, followTa)
  const [sending, setSending] = useState(false)
  const [panel, setPanel] = useState(false)
  // 父对话里的子对话：点开在右栏看，右栏同一时间只显示一个。
  // 右栏开着哪个按父任务 id 记在本地：切走窗口再回来、页面重新加载后还是原来那个
  const [children, setChildren] = useState<ChildSummary[]>([])
  // 子对话的停下原因只有完整任务上有（/children 给的是摘要）：停下的各取一次，行上才能写清是谁结束的
  // （见 stopReasonText）。停下后原因不会变，取到的记在 ref 里，4 秒一次的轮询不再重复问
  const childStopReasons = useRef(new Map<string, StopReason>())
  const loadChildren = useCallback(async (id: string) => {
    const raw = await api.taskChildren(id)
    // 服务端已经给了原因（空字符串是没记）：不用再为每个停下的子对话取一遍完整任务，几十个子对话就是几十份几 MB 的对话
    if (raw.every((c) => c.stopReason !== undefined))
      return raw.map((c): ChildSummary => ({ ...c, stopReason: c.stopReason || undefined }))
    const list = raw.map((c): ChildSummary => ({ ...c, stopReason: undefined }))
    // 又跑起来了就清掉旧原因：下次停下可能是另一个来源
    for (const c of list) if (c.status !== 'stopped') childStopReasons.current.delete(c.id)
    await Promise.all(
      list
        .filter((c) => c.status === 'stopped' && !childStopReasons.current.has(c.id))
        .map((c) =>
          api
            .task(c.id)
            .then((t) => {
              if (t.stopReason) childStopReasons.current.set(c.id, t.stopReason)
            })
            // 没取到就下次轮询再试：先按「已暂停」显示，不在这里编个原因
            .catch(() => {}),
        ),
    )
    return list.map((c) => (c.status === 'stopped' ? { ...c, stopReason: childStopReasons.current.get(c.id) } : c))
  }, [])
  const [openChild, setOpenChild] = useState(() => (pane ? '' : readPaneChild(taskId)))
  // 子对话请用户选择的弹窗收起时记下当时是哪几个提问：来了新的提问再弹出来
  const [askFolded, setAskFolded] = useState('')
  // 宽屏右栏收起：让对话用满整个宽度，收起的按钮还在标题栏
  const [filesFolded, setFilesFolded] = useState(false)
  // 左边空白不够放任务进度时（窄屏），从标题栏打开，浮在对话上面
  const [progressOpen, setProgressOpen] = useState(false)
  // 文件面板默认和中间区域对半（左边栏约 224）；手动拖过之后按拖动后的宽度，至少给中间留 320
  const taskPanel = usePaneWidth(
    'task-panel',
    typeof window === 'undefined' ? 340 : Math.max(320, Math.round((window.innerWidth - 224) / 2)),
    280,
    () => {
      const row = document.querySelector('[data-task-panel]')?.parentElement?.clientWidth ?? window.innerWidth
      return Math.max(340, row - 320)
    },
  )
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  // 子对话的「解决」标记正在提交：防重复点击
  const [resolving, setResolving] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [limit, setLimit] = useState(BLOCK_LIMIT)
  useEffect(() => setLimit(BLOCK_LIMIT), [taskId])
  useEscape(panel, () => setPanel(false))
  useEscape(progressOpen, () => setProgressOpen(false))
  // 对话里点开的运行卡片：右边看这一次运行的实时输出
  const [openRun, setOpenRun] = useState(() => (pane ? 0 : readPaneRun(taskId)))
  // 子对话面板里点开的一次运行：在这块面板内换成那次运行的视图（带返回），不另开一栏。
  // run 为 0 是认不回来是哪次运行（调用失败、还没开始），按「没有启动运行」显示原因
  const [paneRun, setPaneRun] = useState<{ run: number; tool?: ToolUse } | null>(null)
  // Esc 停止正在执行的任务（先确认，免得误触）；右栏开着时 Esc 先关右栏
  const [stopAsk, setStopAsk] = useState(false)
  // 强制停止：连 CLI 进程一起结束（预览、等下一句的进程不留着），用在会话卡住或不想再让它跑的时候
  const [forceAsk, setForceAsk] = useState(false)
  // Agent 输出里点了文件路径：在弹窗里看文件内容
  const [fileTarget, setFileTarget] = useState<{ path: string; line?: number } | null>(null)
  const openFile = useCallback((path: string, line?: number) => setFileTarget({ path, line }), [])
  useEscape(!!task?.working && !panel && !stopAsk && !openRun && !paneRun, () => setStopAsk(true))
  const [view, setView] = useState<'chat' | 'flow'>('chat')
  // 流程图里选中的节点，右栏只看它
  const [flowSel, setFlowSel] = useState('')
  // 右栏「任务进度」里点了哪一步：切到流程视图并选中它，和点流程图的节点一样
  const [focus, setFocus] = useState<{ id: string; at: number }>()
  // 消息区的贴底：打开就在最新内容，流式输出、工具卡片展开、Markdown 变高都跟着走；
  // 用户往上翻时不打扰，回到底部附近再接着跟。切到流程图视图时这个容器不放对话，停止跟随
  const {
    ref: scrollerRef,
    el: scrollerEl,
    onScroll: onScrollerScroll,
    away,
    toBottom,
    pin: stickToBottom,
    unpin: stayPut,
  } = useStickToBottom(taskId, STICK_THRESHOLD, view === 'chat')
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
  const [rewindAsk, setRewindAsk] = useState('')
  // 「记成项目教训」弹窗：存的是那条用户消息的原文
  const [lessonOf, setLessonOf] = useState('')

  // 流式输出每 200ms 推一次：任务本身马上换（对话要实时显示），全局列表的摘要最多 1 秒写一次。
  // 状态、标题、等待确认这些侧栏马上要反映的变化仍然立即写
  const lastTask = useRef<Task | null>(null)
  const summaryAt = useRef(0)
  const summaryTimer = useRef<number | undefined>(undefined)
  const pushSummary = (next: Task) => {
    const prev = lastTask.current
    lastTask.current = next
    const important =
      !prev ||
      prev.id !== next.id ||
      prev.title !== next.title ||
      prev.status !== next.status ||
      prev.working !== next.working ||
      prev.turnDoneAt !== next.turnDoneAt ||
      (prev.requests?.length ?? 0) !== (next.requests?.length ?? 0)
    const now = Date.now()
    if (important || now - summaryAt.current >= 1000) {
      summaryAt.current = now
      if (summaryTimer.current) {
        clearTimeout(summaryTimer.current)
        summaryTimer.current = undefined
      }
      // 全局列表只放摘要，侧栏不用跟着每段输出重新渲染消息
      upsertTask(taskSummary(next))
      return
    }
    if (summaryTimer.current) return
    summaryTimer.current = window.setTimeout(() => {
      summaryTimer.current = undefined
      summaryAt.current = Date.now()
      if (lastTask.current) upsertTask(taskSummary(lastTask.current))
    }, 1000)
  }
  const apply = (next: Task) => {
    setTask(next)
    pushSummary(next)
  }
  // 子对话标记为已解决：请求走子对话一侧的完成流转（服务端判定 → 置完成 → 上报父对话），
  // 还有没收口的东西时返回 409，把卡在哪一项弹给用户；已经解决的重复点击不再发请求
  const resolveChild = async () => {
    if (resolving || !task || task.resolved) return
    setResolving(true)
    try {
      apply(await api.resolveTask(taskId, true))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setResolving(false)
    }
  }
  useEffect(
    () => () => {
      if (summaryTimer.current) clearTimeout(summaryTimer.current)
    },
    [],
  )

  useEffect(() => {
    api
      .task(taskId)
      .then(apply)
      .catch((e) => toast.error((e as Error).message))
    // 换任务时取一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // 右栏开着哪个子对话、哪一次运行：挂载时按父任务 id 读回来（切走窗口、重新加载后不丢）。
  // 子对话自己的右栏（pane）不记也不读
  useEffect(() => {
    if (pane) {
      setOpenChild('')
      setOpenRun(0)
      return
    }
    setOpenChild(readPaneChild(taskId))
    setOpenRun(readPaneRun(taskId))
  }, [taskId, pane])

  // 右栏切换的统一入口：记在本地，下次打开还是这一栏。子对话自己的右栏（pane）不写
  const openChildIn = (id: string) => {
    setOpenChild(id)
    if (id) setOpenRun(0)
    if (!pane) writePaneChild(taskId, id)
  }
  // 消息里「新建子对话」「交给子对话」那一行点开右栏的子对话；引用保持不变，消息行不用跟着重画
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const openChildRow = useCallback((id: string) => openChildIn(id), [taskId, pane])
  const openRunIn = (run: number) => {
    // 子对话自己的面板没有再分一栏：就地换成那次运行的视图，返回后还是这个子对话
    if (pane) {
      setPaneRun(run ? { run } : null)
      return
    }
    setOpenRun(run)
    if (run) setOpenChild('')
    writePaneRun(taskId, run)
  }
  // 子对话面板里点「启动工作流」这一行：认回它启动的是第几次运行，就地打开那次运行的视图
  const openPaneRun = (tool: ToolUse) => setPaneRun({ run: task ? (startedRun(task, tool) ?? 0) : 0, tool })

  // 子对话列表：父对话页开着时定时刷新状态和摘要；子对话自己不显示子对话。
  // 这里只是只读查询，不给子对话发 presence、也不预热它们的 CLI
  useEffect(() => {
    if (!task?.id || task.parentTaskId) {
      setChildren([])
      return
    }
    let alive = true
    const load = () =>
      loadChildren(task.id)
        .then((list) => alive && setChildren((cur) => sameJson(cur, list)))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // 任务 id 变了才重新订阅；子对话的变化靠定时刷新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.parentTaskId])
  // 子对话那边变了就重取子对话列表：待选择的提问变了（在子对话里选完、交给父对话决定），
  // 或者收到子对话的上报（panel === 'child'，含「子对话已完成」）。
  // 列表只读子对话自己的状态、本地不改写：子对话先置完成并上报，这里才跟着变，不抢在它前面
  const childSignal = task?.parentTaskId
    ? ''
    : [
        (task?.messages ?? []).filter((m) => m.panel === 'child').at(-1)?.id ?? '',
        ...(task?.messages ?? [])
          .filter((m) => m.panel === 'ask' && m.ask?.answer === undefined && !m.ask?.delegated)
          .map((m) => m.id),
      ].join(',')
  useEffect(() => {
    if (!task?.id || task.parentTaskId) return
    let alive = true
    loadChildren(task.id)
      .then((list) => alive && setChildren((cur) => sameJson(cur, list)))
      .catch(() => {})
    return () => {
      alive = false
    }
    // 只在子对话那边的状态有变化（上报、提问状态）时刷新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [childSignal])

  // 记着的子对话已经不在这个父对话下了（被删掉）：回退到文件面板并清掉这条记录
  useEffect(() => {
    if (!openChild || !children.length) return
    if (children.some((x) => x.id === openChild)) return
    setOpenChild('')
    writePaneChild(taskId, '')
  }, [children, openChild, taskId])

  // 打开了这个对话：告诉服务端这一轮已经看过（侧栏的橙点消失），
  // 之后离开时 CLI 才能按宽限期回收；没看过就一直留着，回来能直接接着说
  const marked = useRef('')
  useEffect(() => {
    if (marked.current === taskId) return
    marked.current = taskId
    api
      .markTaskSeen(taskId)
      .then(apply)
      .catch(() => {})
    // 只在换到新的对话时报一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // 这一轮完成时页面正开着：直接记为看过，不亮橙点。
  // 不能只靠服务端的在场记录：那是内存里的，面板重启过就没了，用户明明开着却还是标成未读
  useEffect(() => {
    const done = task?.turnDoneAt ?? ''
    if (!done || done === task?.turnSeenAt) return
    const mark = () => {
      // 切到后台时不算看过，等用户切回来再记
      if (document.hidden) return
      api
        .markTaskSeen(taskId)
        .then(apply)
        .catch(() => {})
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
    // apply 每次渲染都是新的，只按这一轮完成和看过的时间重跑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.turnDoneAt, task?.turnSeenAt, taskId])

  // 告诉服务端这个对话页还开着：CLI 回复完会停在等下一句的工具上；宽限期内切回来还能接着说（时长在设置里改）
  useEffect(() => {
    const viewer = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
    const send = (active: boolean) => {
      void api.setPresence(taskId, viewer, active).catch(() => {})
    }
    send(true)
    const visibility = () => send(!document.hidden)
    const hide = () => {
      // 在线演示没有后端，不用发
      if (import.meta.env.VITE_DEMO) return
      const body = JSON.stringify({ viewerId: viewer, active: false })
      navigator.sendBeacon?.(
        `/api/tasks/${encodeURIComponent(taskId)}/presence`,
        new Blob([body], { type: 'application/json' }),
      )
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
      send(false)
    }
  }, [taskId])

  // 打开对话页不启动 CLI：只有真正发消息时才按当前选择启动，免得只是看一眼就起一堆进程
  const running = task?.status === 'running'
  // CLI 真的在处理这一轮才算执行中；等下一句时页面按空闲显示
  const working = task?.working ?? false
  useTaskStream(taskId, running, apply)

  // 任务创建时存下的工作流；现在的版本改过时，可以选择按新的继续
  const workflow = task ? taskWorkflows(task, workflows).workflow : undefined
  const latestWf = workflows.find((w) => w.id === task?.workflowId)
  const wfChanged = !!task?.workflows.length && !!latestWf && latestWf.updatedAt !== workflow?.updatedAt
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  // 对话里派出的子任务：输入框上方的「子任务」栏里列出，点开看它的实时对话流。
  // 工作流任务里节点自己派的子 Agent 显示在节点里，不进这条栏
  const helperIds = useMemo(() => {
    if (!task || task.mode === 'workflow' || (task.runs?.length ?? 0) > 0) return []
    // 旧数据里可能只留下「派出了哪几个」而没有对应的 step（被清掉、导出时丢了）：
    // 只留真的存在的，一个都不剩时不画这条栏，输入框上方不留空行
    const known = new Set(task.steps.map((s) => s.id))
    return [...new Set(task.messages.flatMap((m) => m.spawned ?? []))].filter((id) => known.has(id))
  }, [task])
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

  // 分段只在任务内容变了时重算：打字、开关面板不再把上千条消息重新归一遍
  const blocks = useMemo(() => (task ? toBlocks(task) : []), [task])
  // 很长的任务先只画最后一部分，打开、刷新更快；往前看时再全部显示
  const hidden = Math.max(0, blocks.length - limit)
  const shownBlocks = useMemo(() => blocks.slice(hidden), [blocks, hidden])

  if (!task)
    return (
      <main className="flex flex-1 items-center justify-center text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </main>
    )

  // Chat 模式的聊天不属于项目：没有可看的项目文件，右边的文件栏和展开按钮都不显示
  const noFiles = !task.projectId

  // 执行中也能发：相关的要求会调整当前方向，交不出去的等这一轮结束后接着处理
  const send = async (input?: string) => {
    const text = input ?? followTa.current?.text() ?? ''
    if ((!text.trim() && !files.attachments.length) || sending || files.uploading) return
    const content = forSend(expandQuotes(text, files.attachments), files.attachments.length ? ATTACHMENT_PROMPT : '')
    if (!files.items.length && slash.intercept(content)) return
    setSending(true)
    stickToBottom()
    try {
      const r = await api.sendMessage(task.id, content, files.attachments, false)
      apply(r)
      followTa.current?.setText('')
      files.clear()
      setTimeout(
        () =>
          api
            .task(task.id)
            .then(apply)
            .catch(() => {}),
        200,
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const firstUser = task.messages.find((m) => m.role === 'user')?.id
  const fork = async (messageId: string) => {
    try {
      const f = await api.forkTask(task.id, messageId)
      upsertTask(taskSummary(f))
      toast.success(t('已分叉成新的对话'))
      go(f.projectId ? { page: 'projects', id: f.projectId, sub: f.id } : { page: 'chat', id: f.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const stop = async () => {
    try {
      await api.stopTask(task.id)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const forceStop = async () => {
    try {
      apply(await api.stopTask(task.id, true))
      toast.success(t('已强制停止，CLI 进程已结束'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const resume = async (latest = false) => {
    setResuming(true)
    stickToBottom()
    try {
      apply(await api.resumeTask(task.id, latest))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setResuming(false)
    }
  }
  const rename = async () => {
    const title = renaming?.trim()
    setRenaming(null)
    if (!title || title === task.title) return
    try {
      apply(await api.renameTask(task.id, title))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async () => {
    try {
      await api.deleteTask(task.id)
      removeTask(task.id)
      toast.success(t('已删除任务'))
      go(project ? { page: 'projects', id: project.id } : { page: 'chat' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  // 主流程的节点（不含主 Agent）；「都做完了」要连主 Agent 的整理一起算
  const tops = topSteps(task)
  const roots = task.steps.filter((s) => !s.parentId)
  const runningSteps = task.steps.filter((s) => s.status === 'running')
  const chatAgent = agents.find((a) => a.id === task.agentId)
  // 对话实际用的 CLI；Codex、Claude Code 能在执行中插话，Command Code 这类靠面板的工具取
  const chatCli = chatAgent
    ? agentRun(withTaskModel(chatAgent, task), settings ?? defaultSettings()).cli
    : task.mode === 'chat'
      ? // 不用角色的对话：服务端按对话自己选的 CLI 跑，没选才用默认 CLI，这里要跟它一致
        task.cli || defaultCli(settings ?? defaultSettings())
      : ''
  // 工作流的节点收不了补充时，服务端会留给下一个节点，所以工作流总能补充
  const canSteer = working && (task.mode === 'workflow' || steerable(chatCli))
  // 不用角色的对话按 CLI 显示：署名是 CLI、模型和思考强度，输入框里随时能换
  const byCli = task.mode === 'chat' && !task.agentId
  const chatRun = { cli: task.cli, model: task.model, effort: task.effort }
  const chatLabel = (byCli ? getCli(chatCli)?.name : chatAgent?.name) || t('无角色')
  const changeRun = async (v: ChatRun) => {
    setTask({ ...task, ...v })
    try {
      apply(await api.setChatRun(task.id, v))
      // 空闲时服务端会马上换进程；只有真正在回复这一轮才需要等到下一轮
      if (working) toast(t('改好了，下一轮回复开始生效'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const mainAgent = agents.find((a) => a.id === workflow?.mainAgentId)
  const isFlow = task.mode === 'workflow' && view === 'flow'
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
  // 工作流没走完时输入框上面有「继续流程」，输入框里就不再放「继续执行」
  const flowLeft = task.mode === 'workflow' && !running && flowUnfinished(task, workflow)
  const blocked = task.mode === 'workflow' ? blockedStep(task, taskFlow(task, workflow)) : undefined
  const canResume = (task.status === 'failed' || task.status === 'stopped') && draftEmpty && !flowLeft

  const exportIt = () => downloadTask(task.id, agents).catch((e) => toast.error((e as Error).message))
  /**
   * 复制对话：服务端把这个任务的对话整理成一份转录附件（和「引入会话」同一套格式，超长由它截断并注明），
   * 剪贴板里只放这个文件的路径——粘贴回输入框就会变成一张会话卡片，而不是一大段文字。
   */
  const copyIt = () => {
    void api
      .taskTranscript(task.id)
      .then((a) => navigator.clipboard.writeText(pathText(a.path)))
      .then(
        () => toast.success(t('对话已复制，粘贴到输入框会变成一张会话卡片')),
        (e: Error) => toast.error(t('复制对话失败：{msg}', { msg: e.message })),
      )
  }

  // 右边看某一次运行的实时输出时，输入框跟着挪到那个面板底下，不用关掉再看对话
  // 子对话请用户选择：和 Agent 的提问一样换掉输入框（Agent 自己的提问优先）
  const parentAsks = task.parentAsks ?? []
  const askKey = parentAsks.map((x) => x.id).join(',')
  const askShown = parentAsks.length > 0 && !task.imported && !asksQuestion(task.requests)
  const askOpen = askShown && askFolded !== askKey
  const composer = !task.imported && !asksQuestion(task.requests) && !askOpen && (
    <ChatComposer
      id="follow-up"
      // 草稿由输入框自己记：打字只重渲染输入框，不带着整页消息重画
      draftKey={`task:${taskId}`}
      onEmptyChange={setDraftEmpty}
      onSubmit={(v) => void send(v)}
      files={files}
      taRef={followTa}
      // 拖文件到页面任何位置都算引入到要求里；流程图视图里节点自己有自己的拖拽，不接管
      dropScope={isFlow ? null : dropArea}
      onDropOver={setDropOver}
      menus={
        <>
          {mention.menu}
          {slash.menu}
        </>
      }
      onSync={() => {
        mention.sync()
        slash.sync()
      }}
      onKeyDown={(e) => slash.onKeyDown(e) || mention.onKeyDown(e)}
      attach={{ onMention: mention.start, canMention: !!project?.path, self: task.id }}
      tools={
        <>
          <AskToggle
            value={task.askUser}
            onChange={(v) => {
              setTask({ ...task, askUser: v })
              api.setTaskAskUser(task.id, v).then(apply, (e) => toast.error((e as Error).message))
            }}
          />
          {byCli && <ChatModelPicker value={chatRun} onChange={changeRun} />}
          {task.mode === 'workflow' && (
            <span className="min-w-0 truncate pl-1 text-xs text-subtle">
              {working
                ? tops.filter((s) => s.status === 'running').length > 1
                  ? t('{n} 个节点同时执行中', { n: tops.filter((s) => s.status === 'running').length })
                  : t('执行中，可以随时暂停')
                : blocked
                  ? t('主角色处理后会接着走流程')
                  : roots.every((s) => s.status === 'done')
                    ? t('由主角色 {name} 处理追加要求', { name: mainAgent?.name ?? '' })
                    : task.status === 'failed'
                      ? t('会从失败的节点重新执行')
                      : t('会从没完成的节点继续执行')}
            </span>
          )}
          {task.mode === 'chat' && !byCli && (
            <span className="min-w-0 truncate pl-1 text-xs text-subtle">
              {working ? t('执行中，可以随时暂停') : t('发给 {name}', { name: chatLabel })}
            </span>
          )}
        </>
      }
      running={working}
      onStop={stop}
      leading={
        !working &&
        canResume && (
          <Button
            size="sm"
            variant="secondary"
            className="rounded-lg"
            disabled={resuming}
            onClick={() => resume()}
            title={
              task.mode === 'workflow' && !roots.every((s) => s.status === 'done')
                ? t('从没完成的节点继续执行')
                : t('重新执行最后一条要求')
            }
          >
            {resuming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
            {task.status === 'failed' ? t('重试') : t('继续执行')}
          </Button>
        )
      }
      label={t('继续输入要求')}
      placeholder={
        !working
          ? t('继续输入要求')
          : canSteer
            ? t('执行中也可以输入：相关的会调整当前方向，无关的等这一轮完成后再处理')
            : t('执行中也可以输入，这一轮结束后接着处理')
      }
    />
  )

  return (
    <WithAgents agents={agents}>
      <FileOpenCtx.Provider value={openFile}>
        {/* 子对话（右栏面板或单独打开）里点「启动工作流」：就地换成这次运行的视图，下面带着输入框 */}
        <PaneNavCtx.Provider value={pane || task.parentTaskId ? { run: openPaneRun } : { child: openChildRow }}>
          <ChildListCtx.Provider value={children}>
            <div
              className={cn(
                'relative flex min-w-0 flex-1',
                pane ? 'h-full min-h-0' : 'min-h-[70vh] md:h-full md:min-h-0',
              )}
            >
              <main ref={setDropArea} className="relative flex min-w-0 flex-1 flex-col bg-bg md:h-full">
                {/* 从外面把文件拖到对话页任何位置都算引入到要求里；右栏和流程图有自己的拖拽语义，不在范围内 */}
                {dropOver && <DropOverlay />}
                <header
                  className={cn(
                    // group/hdr：标题栏右侧的「解决」按钮默认隐起来，鼠标进到标题栏或 Tab 聚焦时才显示
                    'group/hdr flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-colors md:px-5',
                    scrolled ? 'border-line' : 'border-transparent',
                  )}
                >
                  <nav aria-label={t('位置')} className="flex min-w-0 flex-1 items-center gap-1 text-[0.84375rem]">
                    {/* 子对话在右栏里：不显示「返回项目」的面包屑，子对话之间用输入框上方的入口切换 */}
                    {!pane && (
                      <>
                        <button
                          onClick={() => go(project ? { page: 'projects', id: project.id } : { page: 'chat' })}
                          className="hidden max-w-[30%] shrink-0 cursor-pointer truncate rounded-md px-1.5 py-1 text-muted hover:bg-sel hover:text-fg sm:block"
                        >
                          {project?.name ?? t('聊天')}
                        </button>
                        <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-subtle sm:block" />
                      </>
                    )}
                    <TaskStatusIcon
                      status={task.childrenWorking ? 'running' : task.status}
                      working={taskBusy(task)}
                      className="ml-1"
                    />
                    {renaming !== null ? (
                      <input
                        autoFocus
                        aria-label={t('任务标题')}
                        value={renaming}
                        maxLength={80}
                        onChange={(e) => setRenaming(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        onBlur={rename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        className="h-8 min-w-0 flex-1 rounded-md border border-accent bg-field px-2 font-medium outline-none"
                      />
                    ) : (
                      <h2
                        title={t('双击重命名')}
                        onDoubleClick={() => setRenaming(task.title)}
                        className="min-w-0 truncate px-1 font-medium"
                      >
                        {task.title}
                      </h2>
                    )}
                    <ProcessMenu taskId={task.id} />
                    {task.simulated && (
                      <span
                        title={t('没有真正调用 Agent，输出是示例')}
                        className="hidden shrink-0 items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[0.6875rem] text-warning md:inline-flex"
                      >
                        <FlaskConical className="h-3 w-3" />
                        {t('模拟')}
                      </span>
                    )}
                    {task.imported && (
                      <span
                        title={t('从导出的文件导入，只能查看')}
                        className="hidden shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] text-accent md:inline-flex"
                      >
                        <FileInput className="h-3 w-3" />
                        {t('导入')}
                      </span>
                    )}
                  </nav>
                  {task.mode === 'workflow' && (
                    <div className="flex shrink-0 rounded-lg bg-field p-0.5" role="tablist" aria-label={t('视图')}>
                      {(
                        [
                          ['chat', t('对话'), MessageSquareText],
                          ['flow', t('流程图'), GitBranch],
                        ] as const
                      ).map(([v, label, Icon]) => (
                        <button
                          key={v}
                          role="tab"
                          aria-label={label}
                          aria-selected={view === v}
                          onClick={() => {
                            setView(v)
                            // 切回对话视图由贴底自己停在最新一行；切到流程图时它把视图自己的滚动放在顶部
                            if (v === 'flow' && scrollerEl.current) scrollerEl.current.scrollTop = 0
                          }}
                          className={cn(
                            'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium',
                            view === v ? 'bg-card text-fg shadow-card' : 'text-muted hover:text-fg',
                          )}
                        >
                          <Icon className={cn('h-3.5 w-3.5', v === 'flow' && 'rotate-90')} />
                          <span className="hidden sm:inline">{label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {task.mode === 'workflow' && tops.length > 0 && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('任务进度')}
                      title={t('任务进度')}
                      aria-expanded={progressOpen}
                      onClick={() => setProgressOpen((v) => !v)}
                    >
                      <ListPlus className="h-4 w-4" />
                    </Button>
                  )}
                  {!pane && !noFiles && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="xl:hidden"
                      aria-label={t('显示文件')}
                      title={t('文件')}
                      onClick={() => setPanel(true)}
                    >
                      <PanelRight className="h-4 w-4" />
                    </Button>
                  )}
                  {/* 子对话面板右上角的「解决」：标记为已解决，记录、分支和未提交改动都保留；已经解决时换成标记 */}
                  {pane &&
                    task.parentTaskId &&
                    (task.resolved ? (
                      <span
                        title={t('已解决')}
                        className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-success/12 px-2 text-[0.6875rem] text-success"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {t('已解决')}
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('解决')}
                        title={t('解决')}
                        disabled={resolving}
                        onClick={() => void resolveChild()}
                        // 默认隐起来（opacity-0），鼠标进标题栏或 Tab 聚焦才显示；
                        // 没有 hover 的设备（触屏、平板）常显，否则根本点不到
                        className="opacity-0 group-hover/hdr:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </Button>
                    ))}
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={t('更多操作')}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </MenuTrigger>
                    <MenuContent>
                      {/* 项目里的父对话有自己的设置：目标、全局规则、子对话 */}
                      {task.projectId && !task.parentTaskId && task.mode === 'chat' && !task.imported && (
                        <MenuItem onSelect={() => setConvSettings(true)}>
                          <Settings2 className="h-4 w-4" />
                          {t('对话设置')}
                        </MenuItem>
                      )}
                      <MenuItem onSelect={() => setRenaming(task.title)}>
                        <Pencil className="h-4 w-4" />
                        {t('重命名')}
                      </MenuItem>
                      <MenuItem onSelect={exportIt}>
                        <Download className="h-4 w-4" />
                        {t('导出任务')}
                      </MenuItem>
                      <MenuItem onSelect={copyIt}>
                        <Copy className="h-4 w-4" />
                        {t('复制对话')}
                      </MenuItem>
                      {/* CLI 还连着、只是在等下一句时也能分析：只有真的在处理这一轮才不行 */}
                      <MenuItem disabled={running && working} onSelect={() => setAnalyzing(true)}>
                        <Sparkles className="h-4 w-4" />
                        {t('AI 分析执行结果')}
                      </MenuItem>
                      {/* 停止只收这一轮，CLI 还留着等下一句；要连进程一起结束时用这一项 */}
                      {!task.imported && (
                        <MenuItem onSelect={() => setForceAsk(true)}>
                          <CircleStop className="h-4 w-4" />
                          {t('强制停止')}
                        </MenuItem>
                      )}
                      {!task.imported && wfChanged && (task.status === 'failed' || task.status === 'stopped') && (
                        <MenuItem onSelect={() => resume(true)}>
                          <RotateCw className="h-4 w-4" />
                          {t('按最新的工作流继续')}
                        </MenuItem>
                      )}
                      <MenuItem danger onSelect={() => setDeleting(true)}>
                        <Trash2 className="h-4 w-4" />
                        {t('删除任务')}
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                  {/* 宽屏右栏一直占着位置，这个按钮把文件面板收起来，让对话用满整个宽度；运行面板、子对话开着时右栏不是文件面板，不显示 */}
                  {!pane && !noFiles && openRun === 0 && !openChild && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="hidden xl:inline-flex"
                      aria-label={t('收起文件面板')}
                      title={t('收起文件面板')}
                      aria-expanded={!filesFolded}
                      onClick={() => setFilesFolded((v) => !v)}
                    >
                      {filesFolded ? <PanelRight className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
                    </Button>
                  )}
                  {pane && onClose && (
                    <Button variant="ghost" size="icon-sm" aria-label={t('关闭子对话')} onClick={onClose}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                  {embed?.actions}
                </header>

                <div className="relative flex min-h-0 flex-1 flex-col">
                  {progressOpen && (
                    <div className="absolute top-3 left-3 z-20 w-[min(340px,calc(100%-1.5rem))] md:left-4">
                      <TaskPanel task={task} onStep={openStep} className="shadow-pop" />
                    </div>
                  )}
                  <div
                    ref={scrollerRef}
                    onScroll={(e) => {
                      onScrollerScroll()
                      setScrolled(e.currentTarget.scrollTop > 4)
                    }}
                    // 流程图视图自己管滚动：上面的流程图固定，只有下面的节点输出滚动
                    className={isFlow ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'flex-1 overflow-y-auto'}
                  >
                    {isFlow ? (
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
                    ) : (
                      <div className="mx-auto flex max-w-(--content-w) flex-col gap-7 px-4 pt-4 pb-8 md:px-6">
                        {hidden > 0 && (
                          <button
                            type="button"
                            onClick={() => setLimit(Infinity)}
                            className="cursor-pointer self-center rounded-full border px-3 py-1 text-xs text-muted transition-colors hover:bg-sel hover:text-fg"
                          >
                            {t('显示更早的 {n} 段', { n: hidden })}
                          </button>
                        )}
                        {shownBlocks.map((b, i) =>
                          b.kind === 'turn' ? (
                            <div key={b.key} className="flex flex-col gap-4">
                              <ChatTurn
                                msgs={b.msgs}
                                task={task}
                                teamNames={teamNames}
                                live={working && i + hidden === blocks.length - 1}
                                last={!working && i + hidden === blocks.length - 1}
                                fallback={byCli ? chatRun : undefined}
                                command={task.command}
                              />
                            </div>
                          ) : b.kind === 'run' ? (
                            task.mode === 'chat' && (task.runs?.length ?? 0) > 0 ? (
                              <RunChecklist key={b.key} task={task} run={b.run} onOpen={() => openRunIn(b.run)} />
                            ) : (
                              <RunCard
                                key={b.key}
                                task={task}
                                run={b.run}
                                name={task.workflowName || workflow?.name}
                                onOpen={() => openRunIn(b.run)}
                              />
                            )
                          ) : b.kind === 'steps' ? (
                            <div key={b.key} className="flex flex-col gap-7">
                              {b.roots.map((r) => (
                                <StepSection
                                  key={r}
                                  task={task}
                                  rootId={r}
                                  msgs={b.byRoot.get(r)!}
                                  teamNames={teamNames}
                                  sticky="chat"
                                />
                              ))}
                            </div>
                          ) : b.m.role === 'user' ? (
                            <UserMessage
                              key={b.m.id}
                              text={b.m.text}
                              at={b.m.at}
                              attachments={b.m.attachments}
                              actions={
                                <>
                                  {/* 用户消息常常是一次纠正：项目里的对话随时可以记成项目教训 */}
                                  {project && !task.imported && (
                                    <button
                                      className={msgAction}
                                      title={t('记成项目教训：以后这个项目里的角色都会照着做')}
                                      aria-label={t('记成项目教训')}
                                      onClick={() => setLessonOf(b.m.text)}
                                    >
                                      <GraduationCap className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {/* 对话停着时可以从这条分叉、撤回到这条（第一条不能撤回） */}
                                  {task.mode === 'chat' && !running && !task.imported && (
                                    <>
                                      <button
                                        className={msgAction}
                                        title={t('从这里分叉：新建一个对话，带着到这条为止的内容')}
                                        aria-label={t('从这里分叉')}
                                        onClick={() => fork(b.m.id)}
                                      >
                                        <GitFork className="h-3.5 w-3.5" />
                                      </button>
                                      {b.m.id !== firstUser && (
                                        <button
                                          className={msgAction}
                                          title={t('撤回到这里：去掉这条和之后的对话，改了再发')}
                                          aria-label={t('撤回到这里')}
                                          onClick={() => setRewindAsk(b.m.id)}
                                        >
                                          <Undo2 className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                    </>
                                  )}
                                </>
                              }
                            />
                          ) : b.m.role === 'system' ? (
                            <NoteMessage
                              key={b.m.id}
                              m={b.m}
                              msgs={task.messages}
                              task={task}
                              className="justify-center text-center"
                            />
                          ) : (
                            <AgentMessage key={b.m.id} m={b.m} task={task} teamNames={teamNames} />
                          ),
                        )}
                        <NextWorkflows task={task} />
                        <EvolutionCard
                          task={task}
                          project={project}
                          kids={children}
                          onSpawned={(id) =>
                            void loadChildren(task.id)
                              .then(setChildren)
                              .catch(() => {})
                              .finally(() => openChildIn(id))
                          }
                        />
                        {running &&
                          task.mode === 'chat' &&
                          working &&
                          (blocks.at(-1)?.kind === 'turn' ? (
                            <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                              <Loader2 className="h-4 w-4 animate-spin text-accent" />
                              <RunPhase task={task} label={t('{name} 正在回复', { name: chatLabel })} />
                              <LiveStats task={task} agentIds={[task.agentId]} />
                            </div>
                          ) : (
                            // 发出消息、还没有输出时就显示是谁在回复、用的哪个模型，不用等第一段输出
                            <PendingReply fallback={byCli ? chatRun : undefined} agentId={task.agentId}>
                              <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                                <RunPhase task={task} label={t('思考中…')} />
                                <LiveStats task={task} agentIds={[task.agentId]} />
                              </div>
                            </PendingReply>
                          ))}
                        {running && task.mode === 'chat' && !working && task.awaitingUser && (
                          <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                            <MessageSquareText className="h-4 w-4 text-subtle" />
                            <span>{t('等待你的下一条消息')}</span>
                            <LiveStats task={task} agentIds={[task.agentId]} />
                          </div>
                        )}
                        {working && task.mode === 'workflow' && runningSteps.length === 0 && (
                          <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                            <Loader2 className="h-4 w-4 animate-spin text-accent" />
                            <RunPhase
                              task={task}
                              label={t('{name} 正在处理', { name: mainAgent?.name ?? t('主角色') })}
                            />
                            <LiveStats task={task} />
                          </div>
                        )}
                        {/* CLI 还没取走的消息已经直接进对话，这里不用再放一份 */}
                      </div>
                    )}
                  </div>
                  {!isFlow && away && (
                    <button
                      type="button"
                      onClick={toBottom}
                      aria-label={t('回到底部')}
                      title={t('回到底部')}
                      className="absolute bottom-3 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 cursor-pointer place-items-center rounded-full border border-line-strong bg-card text-muted shadow-pop transition-colors hover:text-fg"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {/* 计划和子对话贴在输入框上方、在消息流外面：不跟着滚，也不插在用户消息和回复之间。
                    有子对话时分成两行：计划在上、子对话在下，子对话这一行和输入框左对齐，
                    不为了两边并排把子对话挤到右边 */}
                <>
                  {task.plans?.length > 0 && (
                    <div className="shrink-0 px-3 md:px-6">
                      {/* 宽度跟着内容走：计划这一行通常就一小段字，撑满会在右边留下一片空框 */}
                      <div className="mx-auto max-w-(--content-w)">
                        <div className={cn(plainRow, 'mb-1 w-fit max-w-full')}>
                          <PlanButton task={task} children={children} />
                        </div>
                      </div>
                    </div>
                  )}
                  {(() => {
                    // 子对话入口只在父对话里显示（右栏和子对话自己的页面不列子对话）；
                    // 子任务入口哪里都显示：它派在哪个对话里，就在哪里看
                    const showChildren = !pane && !task.parentTaskId && children.length > 0
                    const helpers = helperIds.length ? { task, ids: helperIds, teamNames } : undefined
                    if (!showChildren && !helpers) return null
                    return (
                      <ChildrenBar
                        children={showChildren ? children : []}
                        helpers={helpers}
                        openChild={openChild}
                        onOpen={openChildIn}
                        onClose={() => openChildIn('')}
                      />
                    )
                  })()}
                </>

                <div className="shrink-0 px-3 pt-1 pb-3 md:px-6 md:pb-5">
                  <TaskRequestCard task={task} onAnswered={apply} />
                  {askOpen ? (
                    <ParentAskPanel task={task} onFold={() => setAskFolded(askKey)} />
                  ) : (
                    askShown && (
                      <FoldedAskBar
                        n={parentAsks.length}
                        suggestion={parentAsks.every((a) => a.kind === 'suggestion')}
                        onOpen={() => setAskFolded('')}
                      />
                    )
                  )}
                  <WorktreeBar task={task} />
                  {flowLeft && !task.imported && (
                    <FlowBar
                      task={task}
                      blocked={blocked}
                      resuming={resuming}
                      onResume={() => resume()}
                      onChange={apply}
                    />
                  )}
                  {task.imported && <ImportedBar task={task} onAnalyze={() => setAnalyzing(true)} />}
                  {/* 点开运行面板、子对话里就地打开运行时输入框挪进去，这里先空着，避免出现两个输入框 */}
                  {!openRun && !paneRun && composer}
                  {/* 上下文、Token 用量和环境放在输入框下面，右栏留给文件系统 */}
                  <TaskMeta
                    task={task}
                    projectName={project?.name}
                    projectPath={project?.path}
                    workflowName={task.mode === 'workflow' ? (workflow?.name ?? t('已删除的工作流')) : undefined}
                    node={isFlow ? task.steps.find((s) => s.id === flowSel) : undefined}
                    onTask={apply}
                  />
                </div>
                {/* 子对话里点开的一次运行：盖在这块面板上，子对话本身不卸载，返回后滚动位置原样保留。
                    返回（←）回子对话这一层，✕ 走 onClose 关掉子对话面板本身。
                    输入框跟着放在运行视图底下，和父对话右栏的运行面板一样，看着节点也能补充要求 */}
                {paneRun && (
                  <RunView
                    task={task}
                    run={paneRun.run}
                    tool={paneRun.tool}
                    onBack={() => setPaneRun(null)}
                    onClose={onClose}
                    footer={composer}
                  />
                )}
              </main>

              {/* 右栏：子对话、某一次运行的输出，或者文件系统。外面不滚动，拖动条才不会被 overflow 裁掉。
              点开子对话时中间和右栏各占一半，同一时间只显示一个子对话 */}
              {!pane && (
                <aside
                  aria-label={openChild ? t('子对话') : openRun > 0 ? t('运行 {n}', { n: openRun }) : t('文件')}
                  data-task-panel
                  style={{ width: openChild ? '50%' : taskPanel.width }}
                  className={cn(
                    'shrink-0 flex-col border-l bg-rail',
                    panel || openRun > 0 || openChild
                      ? 'fixed inset-y-0 right-0 z-40 flex max-w-full shadow-pop'
                      : 'hidden',
                    // 宽屏固定在这一栏上：拖动条 absolute 定位在左边缘，位置不能是 static，否则会跑到外层容器上去
                    'xl:relative xl:z-auto xl:flex xl:h-full xl:shadow-none',
                    (filesFolded || noFiles) && openRun === 0 && !openChild && 'xl:hidden',
                  )}
                >
                  {!openChild && !panel && (
                    <ResizeHandle pane={taskPanel} label={t('拖动调整文件面板的宽度')} className="hidden xl:block" />
                  )}
                  {openChild ? (
                    // 对话内容区统一用 bg-bg：署名行等粘贴背景的地方在父对话、右栏、弹窗里颜色都一致
                    <div className="flex min-h-0 w-full flex-1 flex-col bg-bg">
                      <TaskView
                        key={openChild}
                        taskId={openChild}
                        project={project}
                        pane
                        onClose={() => openChildIn('')}
                      />
                    </div>
                  ) : (
                    <>
                      {panel && openRun === 0 && (
                        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 xl:hidden">
                          <span className="text-[0.8125rem] font-semibold">{t('文件')}</span>
                          <Button
                            autoFocus
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('关闭面板')}
                            onClick={() => setPanel(false)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                      {openRun > 0 ? (
                        <RunPanel
                          task={task}
                          run={openRun}
                          name={task.workflowName || workflow?.name}
                          onClose={() => openRunIn(0)}
                          footer={composer}
                        />
                      ) : (
                        <TaskFiles
                          task={task}
                          dir={project?.path}
                          node={isFlow ? task.steps.find((s) => s.id === flowSel) : undefined}
                          onTask={apply}
                        />
                      )}
                    </>
                  )}
                </aside>
              )}
              {(panel || openRun > 0) && (
                <div
                  className="fixed inset-0 z-30 bg-black/40 xl:hidden"
                  onClick={() => (openRun > 0 ? openRunIn(0) : setPanel(false))}
                />
              )}
            </div>
            <ConfirmDialog
              open={stopAsk && working}
              onOpenChange={setStopAsk}
              title={t('停止这个任务？')}
              description={t('正在执行的 Agent 会被停下，之后可以点「继续执行」从中断的地方接着做。')}
              confirmText={t('停止')}
              onConfirm={async () => {
                await stop()
                setStopAsk(false)
              }}
            />
            <ConfirmDialog
              open={forceAsk}
              onOpenChange={setForceAsk}
              title={t('强制停止这个对话？')}
              description={t(
                '正在执行的这一轮会被停下，CLI 进程直接结束（不再留着等下一句）。这一轮已经写出的内容保留，下一句会重新开一个会话。',
              )}
              confirmText={t('强制停止')}
              onConfirm={async () => {
                await forceStop()
                setForceAsk(false)
              }}
            />
            {lessonOf && project && (
              <RecordLessonDialog
                project={project}
                text={lessonOf}
                taskId={task.id}
                taskTitle={task.title}
                onClose={() => setLessonOf('')}
                // 对话里的角色知道刚才哪里做错了，交给它整理；工作流任务和导入的任务没有能接话的角色
                onAskAgent={
                  task.mode === 'chat'
                    ? async (message) => {
                        stickToBottom()
                        apply(await api.sendMessage(task.id, message, [], false))
                      }
                    : undefined
                }
              />
            )}
            <ConfirmDialog
              open={!!rewindAsk}
              onOpenChange={(o) => !o && setRewindAsk('')}
              title={t('撤回到这条消息？')}
              description={t(
                '这条消息和之后的对话会去掉，内容放回输入框，改了可以再发。Agent 会从这条之前接着聊；已经改动的文件不会撤销，需要的话在「更改」里撤销。',
              )}
              confirmText={t('撤回')}
              onConfirm={async () => {
                try {
                  const r = await api.rewindTask(task.id, rewindAsk)
                  apply(r.task)
                  followTa.current?.setText(r.text)
                  // 那条消息的图片、文件、引用一起放回来：卡片已经在文字里
                  files.replace(r.attachments ?? [])
                  setRewindAsk('')
                  followTa.current?.focus()
                } catch (e) {
                  toast.error((e as Error).message)
                }
              }}
            />
            <DeleteTaskDialog
              task={task}
              open={deleting}
              onOpenChange={setDeleting}
              title={t('删除任务「{title}」？', { title: task.title })}
              description={t('会删除这个任务的对话记录，不会撤销已经改动的文件。')}
              onConfirm={remove}
            />
            <FileDialog taskId={task.id} target={fileTarget} onOpenChange={(o) => !o && setFileTarget(null)} />
            {convSettings && (
              <ConversationSettingsDialog
                task={task}
                open={convSettings}
                onOpenChange={setConvSettings}
                onSaved={apply}
              />
            )}
            <AnalyzeDialog
              open={analyzing}
              onOpenChange={setAnalyzing}
              tasks={async () => [await api.task(task.id)]}
              projectId={task.projectId}
            />
          </ChildListCtx.Provider>
        </PaneNavCtx.Provider>
      </FileOpenCtx.Provider>
    </WithAgents>
  )
}

/**
 * 对话里启动的一次工作流运行：按节点列成一张清单卡片。
 * 节点下有多步 / 子 Agent 时缩进一级展示，点卡片去右栏看完整输出。
 */
function RunChecklist({ task, run, onOpen }: { task: Task; run: number; onOpen: () => void }) {
  const { agents } = useData()
  const rec = task.runs?.find((r) => r.id === run)
  const steps = task.steps.filter((s) => s.runId === run && s.kind !== 'main')
  const roots = steps.filter((s) => !s.parentId)
  const kids = (id: string) => steps.filter((s) => s.parentId === id && (s.slot === 'step' || s.slot === 'sub'))
  const working = steps.some((s) => s.status === 'running')
  const status: Task['status'] =
    rec?.status === 'running' || (!rec?.status && working) ? 'running' : (rec?.status ?? 'done')
  const who = (id: string) => agents.find((a) => a.id === id)?.name ?? ''
  const row = (s: TaskStep, child = false) => (
    <div key={s.id} className={cn('flex min-w-0 items-center gap-2 py-1.5', child ? 'pr-3 pl-10' : 'px-3')}>
      {child && <span className="h-px w-3 shrink-0 bg-line-strong" />}
      <StepIcon status={s.status} />
      <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{s.title}</span>
      <span className="shrink-0 text-[0.6875rem] text-subtle">{who(s.agentId)}</span>
    </div>
  )
  return (
    <div className="overflow-hidden rounded-xl border border-line-strong bg-card shadow-card">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-center gap-2 border-b px-3 py-2 text-left transition-colors hover:bg-sel/40"
      >
        <TaskStatusIcon status={status} working={working} />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
          {rec?.workflowName || task.workflowName || t('工作流')}
        </span>
        <span className="shrink-0 text-xs text-subtle">{t('第 {n} 次运行', { n: run })}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
      </button>
      <div className="flex flex-col divide-y divide-line">
        {roots.map((s) => (
          <div key={s.id}>
            {row(s)}
            {kids(s.id).map((k) => row(k, true))}
          </div>
        ))}
        {!roots.length && <div className="px-3 py-2 text-xs text-subtle">{t('正在准备节点…')}</div>}
      </div>
    </div>
  )
}

/** 导入的任务在输入框的位置显示来源，只能查看；可以交给 AI 分析 */
function ImportedBar({ task, onAnalyze }: { task: Task; onAnalyze: () => void }) {
  const info = task.imported!
  return (
    <div className="mx-auto flex max-w-(--content-w) items-center gap-3 rounded-2xl border border-line-strong bg-card px-4 py-3 shadow-card">
      <FileInput className="h-4 w-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1 text-[0.8125rem] text-muted">
        {t('这是从文件导入的任务（{at} 导出{app}），只能查看，不能继续执行。', {
          at: (info.exportedAt || info.at).slice(0, 16).replace('T', ' '),
          app: info.app ? t('，面板 {v}', { v: info.app }) : '',
        })}
      </span>
      <Button size="sm" variant="secondary" className="shrink-0 rounded-lg" onClick={onAnalyze}>
        <Sparkles className="h-3.5 w-3.5 text-accent" />
        {t('AI 分析')}
      </Button>
    </div>
  )
}

/** 用户消息下面的小按钮（分叉、撤回） */

/**
 * 子对话入口：贴在输入框上方的一条状态栏，点开是悬浮窗列表。
 * 默认只列进程还活着的子对话（预热、等下一句、正在执行），切到「全部」能看到已关闭的。
 * 排序：正在执行的在上，其余按最近一条消息的时间倒序。
 */
function ChildrenBar({
  children,
  helpers,
  openChild,
  onOpen,
  onClose,
}: {
  children: ChildSummary[]
  /** 派出的子任务：和子对话同一行，点开看它的实时对话流 */
  helpers?: { task: Task; ids: string[]; teamNames: Set<string> }
  openChild: string
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscape(open, () => setOpen(false))
  // 点外面关：和项目里其他浮层一样
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  // 在等你选择的子对话：最醒目，排在状态栏最前面；已经解决的不再算你要处理的事
  const asking = children.filter((c) => c.asking && !c.resolved)
  const busy = sortChildren(runningChildren(children))
  const working = busy.length
  const alive = children.filter((c) => c.cliAlive)
  // 分母是子对话总数，但不比执行中的少：进程刚好在启动、进程信息还没回来时不能显示成 3/0
  const total = Math.max(alive.length, working)
  // 「运行中」只列真正在执行（working）的：进程活着但在等下一句的，在它自己页面上是「等待你的下一条消息」
  const shown = sortChildren(all ? children : runningChildren(children))
  const current = children.find((c) => c.id === openChild)

  return (
    <div ref={ref} className="shrink-0 px-3 md:px-6">
      {/* 弹窗以这一行内容为基准：左边和输入框左对齐，不跟着外层的内边距和居中偏移走 */}
      <div className="relative mx-auto max-w-(--content-w)">
        {/* 这一行铺满内容宽：小卡列表和右侧关闭按钮要有稳定的左右边界，换行时关闭按钮才不跑位 */}
        <div className={cn(plainRow, 'mb-1.5 flex-wrap')}>
          {/* 计划已经单独占一行（见调用处）：这里只放子对话自己的那几样，不为了并排把内容挤到右边 */}
          {children.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={
                working > 0
                  ? t('子对话，{n} 个在执行，共 {total} 个', { n: working, total })
                  : t('子对话 {n}', { n: total })
              }
              onClick={() => setOpen((v) => !v)}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-[0.8125rem] text-muted transition-colors hover:bg-sel hover:text-fg"
            >
              <GitFork className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className="shrink-0 font-medium">{t('子对话')}</span>
              {/* 运行中的在前、总数在后：转圈 1/2 读作「1 个在跑，一共 2 个」，总数不重复说两遍 */}
              {working > 0 ? (
                <span className="flex shrink-0 items-center gap-1 pr-1 text-xs text-accent tabular-nums">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {working}/{total}
                </span>
              ) : (
                // 没在跑时只写总数，不出现 0/2
                <span className="shrink-0 text-xs text-subtle tabular-nums">{total}</span>
              )}
            </button>
          )}
          {/* 派出的子任务跟在子对话后面：同一栏、同一行，点开看它的实时对话流 */}
          {helpers && <HelperBar task={helpers.task} ids={helpers.ids} teamNames={helpers.teamNames} />}
          {asking.length > 0 && (
            <button
              type="button"
              onClick={() => onOpen(asking[0].id)}
              title={asking.map((c) => c.title).join('\n')}
              className="flex h-7 max-w-64 min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-2.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15"
            >
              <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {asking.length > 1
                  ? t('{n} 个子对话请你选择', { n: asking.length })
                  : t('「{title}」请你选择', { title: asking[0].title })}
              </span>
            </button>
          )}
          {/* 正在执行的子对话一个一块，宽度固定不随内容和个数伸缩：名字后面接着它这会儿在做什么，点一下在右栏打开 */}
          {busy.length > 0 && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {busy.slice(0, 3).map((c) => {
                // 执行中很久没新输出：文字变黄 / 红，一眼看出可能是它卡住了（等待原因不在这里标）
                const stale = staleLine(c)
                const line = childNote(c, true)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onOpen(c.id)}
                    title={`${c.title}${line ? ` · ${line}` : ''}${stale ? ` · ${stale.text}` : ''}`}
                    className={cn(
                      'flex h-7 w-56 max-w-full min-w-0 shrink cursor-pointer items-center gap-2 rounded-lg border bg-card px-2.5 text-xs transition-colors hover:bg-sel',
                      c.id === openChild ? 'border-line-strong' : 'border-line',
                    )}
                  >
                    {/* 执行中的子对话用和列表、行首同一套转圈，不再另画一个跳动的小点 */}
                    <Loader2 className={cn('h-3 w-3 shrink-0 animate-spin', stale?.cls ?? 'text-accent')} />
                    <span className="max-w-[60%] min-w-0 shrink-0 truncate font-medium text-fg">{c.title}</span>
                    <span className={cn('min-w-0 flex-1 truncate', stale?.cls ?? 'text-subtle')}>
                      {stale ? stale.text : line}
                    </span>
                  </button>
                )
              })}
              {busy.length > 3 && <span className="shrink-0 text-xs text-subtle">+{busy.length - 3}</span>}
            </div>
          )}
          {current && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('关闭子对话')}
              title={t('关闭子对话')}
              className="ml-auto grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {open && (
          <div className="absolute bottom-full left-0 z-30 mb-1 w-[min(420px,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-line-strong bg-card shadow-pop">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="text-[0.8125rem] font-medium">{t('子对话')}</span>
              <div className="ml-auto flex shrink-0 rounded-md bg-field p-0.5">
                {(
                  [
                    [false, t('运行中')],
                    [true, t('全部')],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={String(v)}
                    type="button"
                    aria-pressed={all === v}
                    onClick={() => setAll(v)}
                    className={cn(
                      'cursor-pointer rounded px-2 py-0.5 text-xs',
                      all === v ? 'bg-card text-fg shadow-card' : 'text-muted hover:text-fg',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[min(46vh,320px)] overflow-y-auto p-1">
              {childGroups(shown, all).map((g) => (
                <Fragment key={g.key}>
                  {g.label && (
                    <p className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-subtle">
                      {g.label} · {g.items.length}
                    </p>
                  )}
                  {g.items.map((c) => {
                    // 图标、行内徽标、摘要都读同一个判定（见 shared/task.ts 的 childIcon）：
                    // 以前图标按 working/spin/waiting、徽标按 resolved/asking/plan、摘要按 childRunning 各算一套，
                    // 于是出现「已解决」和「执行中」同屏、已完成分组里的项画成暂停
                    const icon = childIcon(c)
                    // 那一行下面的说明：执行中写正在做什么，其余写在等什么或最近结果；很久没新输出时标色
                    const line = childNote(c, icon === 'running')
                    const stale = staleLine(c)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          // 点条目只切换右边要看的子对话，浮层不关；点浮层外面或按 Escape 才关
                          onOpen(c.id)
                        }}
                        className={cn(
                          'flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sel',
                          c.id === openChild && 'bg-sel',
                        )}
                      >
                        <span className="mt-0.5 shrink-0">
                          <TaskStatusIcon
                            status={c.status}
                            icon={icon}
                            label={c.status === 'stopped' ? stopReasonText(c.stopReason) : undefined}
                          />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className={cn('min-w-0 truncate text-[0.8125rem]', c.cliAlive ? '' : 'text-muted')}>
                              {c.title}
                            </span>
                            {!c.cliAlive && (
                              <span className="shrink-0 rounded-full bg-field px-1.5 text-[0.6875rem] text-subtle">
                                {t('已关闭')}
                              </span>
                            )}
                            {/* 徽标也按图标分支：同一行只说一件事，不会「已解决」和「执行中」一起出现 */}
                            {c.resolved && icon === 'done' && (
                              <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-success/12 px-1.5 text-[0.6875rem] text-success">
                                <CheckCircle2 className="h-3 w-3" />
                                {t('已解决')}
                              </span>
                            )}
                            {icon === 'waiting' && (
                              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[0.6875rem] text-warning">
                                {t('等你选择')}
                              </span>
                            )}
                            {icon === 'running' && !!c.plan && (
                              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[0.6875rem] text-warning">
                                {t('计划 {done}/{total}', { done: c.plan.done, total: c.plan.total })}
                              </span>
                            )}
                            {icon === 'running' && (
                              <span className="shrink-0 text-[0.6875rem] text-accent">{t('执行中')}</span>
                            )}
                            {/* 停下也说清是谁结束的：只有用户按的暂停才是「已暂停」（见 stopReasonText） */}
                            {(icon === 'stopped' || icon === 'idle') && (
                              <span className="shrink-0 text-[0.6875rem] text-subtle">
                                {stopReasonText(c.stopReason)}
                              </span>
                            )}
                          </span>
                          {(line || stale) && (
                            <span className="flex min-w-0 items-center gap-1">
                              {line && <span className="line-clamp-1 min-w-0 text-xs text-subtle">{line}</span>}
                              {stale && <span className={cn('shrink-0 text-xs', stale.cls)}>· {stale.text}</span>}
                            </span>
                          )}
                          {c.branch && (
                            <span className="flex min-w-0 items-center gap-1 font-mono text-[0.6875rem] text-subtle">
                              <GitBranch className="h-3 w-3 shrink-0" />
                              <span className="truncate">{c.branch}</span>
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </Fragment>
              ))}
              {!shown.length && (
                <p className="px-2.5 py-3 text-xs text-subtle">{all ? t('还没有子对话') : t('没有正在运行的子对话')}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 「全部」里按状态分组看子对话：要你处理的（等确认、失败）在最上面，然后执行中、未完成、做完的、停下的；
 * 「运行中」只列真正在执行（working）的几个，不分组。分组用 childStage（taskStage 再加上「计划没做完」）：
 * 和状态图标、行内标签是同一套映射，排序也用这一套，组内顺序和 sortChildren 一致
 */
function childGroups(list: ChildSummary[], grouped: boolean) {
  if (!grouped) return [{ key: 'all', label: '', items: list }]
  const groups: { key: TaskStage; label: string; items: ChildSummary[] }[] = [
    { key: 'you', label: t('需要你处理'), items: [] },
    { key: 'running', label: t('执行中'), items: [] },
    { key: 'unfinished', label: t('未完成'), items: [] },
    { key: 'done', label: t('已完成'), items: [] },
    { key: 'stopped', label: t('已停止'), items: [] },
  ]
  for (const c of list) {
    const g = groups.find((x) => x.key === childStage(c))
    if (g) g.items.push(c)
  }
  return groups.filter((g) => g.items.length)
}

/** 输入框上面一行的提示条（没走完的流程）：本身有实质内容，保留虚线圆角的框 */
const barRow =
  'flex items-center gap-2 rounded-xl border border-dashed border-line-strong bg-card/60 px-3 py-2 text-[0.8125rem]'
/**
 * 计划和子对话那两行：不套框，当作输入框上方的一行轻量信息。
 * 左内边距 2.5 加上行内按钮自己的 px-1.5，正好和输入框文字（外层 px-3/md:px-6 + 文字 px-4）左对齐
 */
const plainRow = 'flex min-w-0 items-center gap-2 px-2.5 text-[0.8125rem]'
const barIcon =
  'grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg disabled:opacity-40'

/** 工作流没走完（失败、暂停、停在某个节点的结论上）：可以继续流程，或者结束它不再继续 */
function FlowBar({
  task,
  blocked,
  resuming,
  onResume,
  onChange,
}: {
  task: Task
  blocked?: TaskStep
  resuming: boolean
  onResume: () => void
  onChange: (t: Task) => void
}) {
  const [asking, setAsking] = useState(false)
  const tops = topSteps(task)
  const failed = tops.find((s) => s.status === 'failed')
  const left = tops.filter((s) => s.status !== 'done' && s.status !== 'skipped').length
  const what = blocked
    ? t('流程停在「{title}」：结论不通过，后面的节点还没执行', { title: blocked.title })
    : failed
      ? t('流程没有完成：「{title}」执行失败', { title: failed.title })
      : left
        ? t('流程没有完成，还有 {n} 个节点没执行', { n: left })
        : t('流程没有完成，主角色还没整理结果')
  return (
    <div className="mx-auto mb-2 max-w-(--content-w)">
      <div className={barRow}>
        <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate" title={what}>
          {what}
        </span>
        <button
          type="button"
          disabled={resuming}
          onClick={onResume}
          title={
            blocked ? t('从「{title}」重新检查，接着走流程', { title: blocked.title }) : t('从没完成的节点继续执行')
          }
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
        >
          {resuming ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
          {t('继续流程')}
        </button>
        <button
          type="button"
          aria-label={t('结束流程')}
          title={t('结束流程，不再继续')}
          onClick={() => setAsking(true)}
          className={barIcon}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('结束这个流程？')}
        description={t('没完成的节点不再执行，已经做完的改动保留。之后输入的要求由主角色直接处理。')}
        confirmText={t('结束流程')}
        onConfirm={() =>
          api
            .endFlow(task.id)
            .then((x) => {
              onChange(x)
              setAsking(false)
            })
            .catch((e) => {
              setAsking(false)
              toast.error((e as Error).message)
            })
        }
      />
    </div>
  )
}

/**
 * 输入框上面的独立分支条：从哪个分支开出 → 独立分支，合没合回去（绿勾 / 感叹号），
 * 这一轮没在动手时可以直接合并或删除
 */
function WorktreeBar({ task }: { task: Task }) {
  const wt = task.worktree
  const items = useWorktrees(task.id, worktreeKey(task), !!wt)
  const actions = useWorktreeActions(task.id)
  // 要改文件时才开：还没开时说明现在在哪个目录，免得以为已经在分支里了
  if (!wt && task.wantsWorktree)
    return (
      <div className="mx-auto mb-2 flex max-w-(--content-w) items-center gap-2 rounded-xl border border-line bg-card/60 px-3 py-2 text-[0.8125rem]">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 text-muted">{t('还在项目目录里查看，要改文件时才开独立分支')}</span>
      </div>
    )
  if (!wt) return null
  const item = items?.find((x) => x.taskId === task.id)
  const active = wt.state === 'active'
  const busy = actions.busy === task.id
  return (
    <div className="mx-auto mb-2 flex max-w-(--content-w) flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-line bg-card/60 px-3 py-1.5 text-[0.8125rem]">
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
      ) : item ? (
        <WorktreeMark item={item} />
      ) : (
        <GitBranch className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-accent' : 'text-subtle')} />
      )}
      <span className="flex min-w-0 items-center gap-1 font-mono text-[0.78125rem]">
        <span className="shrink-0 text-subtle">{wt.baseBranch || 'HEAD'}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-subtle" />
        <span className={cn('min-w-0 truncate', active ? 'text-fg' : 'text-subtle line-through')} title={wt.path}>
          {wt.branch}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle">
        {item
          ? worktreeSummary(item)
          : !active
            ? wt.state === 'merged'
              ? t('已合并到「{branch}」，分支已删除', { branch: wt.note || wt.baseBranch })
              : t('已删除，改动没有合并')
            : t('在独立分支上执行，不改动项目目录')}
      </span>
      {item && item.state === 'active' && !item.working && (
        <span className="flex shrink-0 items-center gap-1">
          {needsMerge(item) && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7"
              disabled={busy}
              onClick={() => void actions.merge(item)}
            >
              <GitMerge className="h-3.5 w-3.5" />
              {t('合并到「{branch}」', { branch: item.baseBranch || t('原分支') })}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            title={t('删除独立分支')}
            aria-label={t('删除独立分支')}
            className="hover:bg-danger/10 hover:text-danger"
            onClick={() => actions.askRemove(item)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      )}
      {actions.confirm}
    </div>
  )
}

/** 对话的一轮回复：署名用这条回复记下的 CLI 和模型；以前的回复没记，用对话现在的设置 */
function ChatTurn({
  msgs,
  task,
  teamNames,
  live,
  last,
  fallback,
  command,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live: boolean
  last: boolean
  fallback?: ChatRun
  /** 对话任务最近一次启动 Agent 的命令 */
  command?: string[]
}) {
  const run = msgs.find((m) => m.run)?.run
  const cur = useChatRun(fallback ?? { cli: '', model: '', effort: '' }).run
  const author = useRunAuthor(fallback ? (run ?? cur) : undefined)
  // 这一轮实际启动的命令：署名行最右边显示，和工作流节点标题旁的一样；按 Agent 显示的对话没有署名行，交给名字那行
  const withCommand = author ? { ...author, command } : undefined
  return (
    <ChatReply
      msgs={msgs}
      task={task}
      teamNames={teamNames}
      live={live}
      last={last}
      fold
      author={withCommand}
      command={withCommand ? undefined : command}
    />
  )
}

/** 回复还没开始输出时的署名：按 CLI 显示的对话用现在选的 CLI 和模型，其他对话用 Agent */
function PendingReply({
  fallback,
  agentId,
  children,
}: {
  fallback?: ChatRun
  agentId: string
  children: React.ReactNode
}) {
  const { agents } = useData()
  const { modelOf } = useAgentView()
  const cur = useChatRun(fallback ?? { cli: '', model: '', effort: '' }).run
  const byCli = useRunAuthor(fallback ? cur : undefined)
  const a = agents.find((x) => x.id === agentId)
  const author = byCli ?? (a ? { name: a.name, cli: a.cli, icon: a.icon, model: modelOf(a) } : undefined)
  if (!author) return <>{children}</>
  return <PendingAuthor author={author}>{children}</PendingAuthor>
}

/**
 * 执行中的状态文字：最近一段时间没有任何输出、也没有工具在跑，说明在等模型的下一段。
 * 模型请求本身要几秒到几十秒（上下文越大越久），标出来，免得看起来像卡在工具上
 */
function RunPhase({ task, label }: { task: Task; label: string }) {
  const now = useNow(true)
  const idle = now - Date.parse(task.updatedAt)
  // 执行中发的补充排在最后：还在跑的命令在它前面那条回复里，不能只看最后一条
  const busy =
    !!task.requests.length ||
    task.messages.slice(-4).some((m) => m.tools.some((x) => x.running || (x.ms === undefined && !!x.startedAt)))
  // 对话派出的子任务还没做完：对话停在这里等它们，结果交回后接着回复
  const helpers = task.steps.filter((s) => s.slot === 'sub' && s.parentId === '@chat' && s.status === 'running')
  if (helpers.length && !busy) return <>{t('等待 {n} 个子任务完成', { n: helpers.length })}</>
  return <>{busy || idle < 1500 ? label : t('等待模型 · 已 {n} 秒', { n: Math.floor(idle / 1000) })}</>
}
