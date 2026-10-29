import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { t } from '@shared/i18n'
import { ANCHOR_RETRY_MS, ANCHOR_TRIES, jumpToMessage } from '@/lib/message-anchor'
import { expandQuotes, useQuoteTarget } from '@/lib/quote'
import { toast } from '@/lib/toast'
import { RouteCard } from './RouteCard'
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
  Workflow as WorkflowIcon,
  Download,
  FileCode2,
  FileInput,
  Sparkles,
  Settings2,
  GraduationCap,
  CircleStop,
  Copy,
  ClipboardList,
  PictureInPicture2,
  Upload,
} from 'lucide-react'
import { ConversationSettingsDialog } from './ConversationSettingsDialog'
import { ProcessMenu } from './ProcessPanel'
import { TurnMenu } from './TurnMenu'
import { keepLiveFields, windowedForSummary } from '@/lib/live-fields'
import { latestTurnIndex } from '@/lib/latest-turn'
import { WaitDots, cliAliveHint, cliTreeAlive } from './CliAlive'
import {
  type Attachment,
  type Project,
  type StopReason,
  type Task,
  type TaskMessage,
  type TaskStep,
  type ToolUse,
  type TaskSeenResult,
} from '@shared/schema'
import { ChatModelPicker, useChatRun, useRunAuthor, type ChatRun } from './ChatModelPicker'
import { blockedStep, flowUnfinished, MAIN_STEP, rootStepId, taskFlow, taskWorkflows, topSteps } from '@shared/flow'
import {
  childSeenLocally,
  childSpinning,
  childWait,
  helperRunning,
  taskActive,
  taskBusy,
  taskState,
  taskWaitText,
  taskSummary,
  withTaskModel,
  TRASH_RETENTION_DAYS,
  type ChildWait,
} from '@shared/task'
import { agentRun, defaultCli, defaultSettings } from '@shared/settings'
import { getCli, steerable } from '@shared/clis'
import { api, type TaskPage } from '@/lib/api'
import { useTaskStream } from '@/lib/task-stream'
import { useLoadTrace } from '@/lib/useLoadTrace'
import { minimizeTask, minimizeBackRoute } from '@/lib/mini-task'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import {
  apiQueueWait,
  deliveredToCli,
  fmtDuration,
  messageRecorded,
  startedRun,
  tpsNow,
  withTurnSeenAt,
} from '@/lib/tasks'
import { paneHalfWidth, PANE_DEFAULT_SSR, rowWidthFromWindow } from '@/lib/pane-width'
import { WithAgents, useData, useNav } from '@/lib/data'
import { downloadTask, downloadTaskHtml, startAnalysis } from '@/lib/task-transfer'
import { withImportedAgents } from '@shared/task-export'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { InlineRename } from '@/components/ui/inline-rename'
import { IconButton, ToggleIconButton } from '@/components/ui/icon-button'
import { Badge } from '@/components/ui/badge'
import { StatusPill } from '@/components/ui/status-pill'
import { ConversationShell, useConversationScroll } from '@/components/chat/ConversationShell'
import { AgentMessage, ChatReply, DeliveryLine, NoteMessage, PendingAuthor } from './Messages'
import { ReceivedRow } from './PeerMessage'
import { useAgentView } from '@/lib/agent-view'
import { LiveStats } from './LiveStats'
import { NextWorkflows } from './NextWorkflows'
import { AnalyzeDialog } from './Evolution'
import { AnalysisPanel, reportTitle } from './AnalysisPanel'
import { AnalysisMark } from './AnalysisMark'
import { findReport, isAnalysisTask } from '@/lib/analysis-report'
import { StepSection } from './StepSection'
import { LoadTrace, LoadTracePill } from './LoadTrace'
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
import { ConversationTabs } from './ConversationTabs'
import { ChatRail, useChatRail } from './ChatRail'
import { FileDialog, FileOpenCtx } from './FileDialog'
import { JobDialog, type JobTarget } from './JobDialog'
import { ChildListCtx, PaneNavCtx } from './child-open'
import { type ChildSummary } from './child-line'
import { ChildSwitcher } from './ChildSwitcher'
import { ParentAskPanel } from './ChildAskCard'
import { TaskRequestCard, asksQuestion } from './RequestCard'
import { useSlashMenu } from '@/components/chat/SlashMenu'
import { AskToggle } from '@/components/chat/AskToggle'
import { StepIcon, TaskStatusIcon } from './TaskStatusIcon'
import { ATTACHMENT_PROMPT, DropOverlay, useAttachments, useFileMention } from '@/components/chat/Attachments'
import { ChatComposer } from '@/components/chat/ChatComposer'
import type { RichInputHandle } from '@/components/chat/RichInput'
import { dropChip, forSend, pathText } from '@shared/composer'
import { UserMessage } from '@/components/chat/ChatMessage'
import { RecordLessonDialog } from '@/components/projects/Lessons'
import {
  OPEN_CHILD_EVENT,
  SHOW_PARENT_EVENT,
  paneChildKey,
  paneFilesKey,
  paneReportKey,
  paneRunKey,
} from '@/lib/ai-window'

/** 流程图视图用到的画布库比较大，切到流程图时才加载 */
const TaskFlow = lazy(() => import('./TaskFlow').then((m) => ({ default: m.TaskFlow })))

type Block =
  | { kind: 'msg'; m: TaskMessage }
  /** 对话里 Agent 连续的回复（一轮），完成后折叠过程 */
  | { kind: 'turn'; key: string; msgs: TaskMessage[] }
  | { kind: 'steps'; key: string; roots: string[]; byRoot: Map<string, TaskMessage[]> }
  /** 工作流的一次运行：节点输出去右边的面板里看 */
  | { kind: 'run'; key: string; run: number }

/** 这一段里有哪些消息：轮次目录跳到某条消息时找它在第几段（被折叠在更早的段里时先显示出来） */
function blockMsgIds(b: Block): string[] {
  if (b.kind === 'msg') return [b.m.id]
  if (b.kind === 'turn') return b.msgs.map((m) => m.id)
  if (b.kind === 'steps') return [...b.byRoot.values()].flat().map((m) => m.id)
  return []
}

/** 以前新建子对话时记的系统提示（中文、英文界面各一种写法） */
const OLD_CREATED =
  /^(新建了子对话「.*」，这条消息交给它处理|Created sub-conversation “.*”; this message is handed to it)$/

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
    if (m.role === 'system' && !m.step && !m.panel && OLD_WORKTREE.test(m.text)) continue
    // 派出的子任务、面板推回的结果（后台命令、合并编译、子任务结果）都是 AI 这一轮回复里的一行，
    // 归进当前这轮回复，不单独成段，也不显示成用户消息
    // 父对话交代的任务、回答（role 是 user）：自成一段，画成「接收消息」，不显示成用户消息
    if (!m.step && m.peer && m.role === 'user') {
      blocks.push({ kind: 'msg', m })
      continue
    }
    if (!m.step && ((!byRun && m.spawned?.length) || m.panel || m.peer)) {
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

/**
 * 子对话列表的刷新间隔：有子对话在跑（转圈）时看勤一点，都静止时只是等它再动，没必要每 4 秒问一遍。
 * 没有子对话时根本不轮询（见下文）
 */
const CHILD_POLL_ACTIVE_MS = 4000
const CHILD_POLL_IDLE_MS = 15_000

/** 一个任务的对话页：上方是执行输出，下方继续输入要求，右侧是进度、上下文和更改 */
/** project 为空时是 Chat 模式的聊天，不属于任何项目 */
/** 任务页一开始最多画多少段（一个节点组、一轮对话算一段） */
const BLOCK_LIMIT = 30
/**
 * 打开对话时先取最近多少条消息：整份对话可能几 MB，首屏只要最后这一段，
 * 更早的点和翻页一样往前取（见 loadEarlier）
 */
const OPEN_MESSAGE_LIMIT = 50

/** 右栏拖动：再窄放不下列表里的路径和按钮，再宽中间读对话的地方就没了 */
const PANE_MIN = 280
/** 文件面板默认最宽多少：右栏是辅助，默认不和对话平分 */
const FILES_PANE_CAP = 440
/** 右栏拖动时中间至少留下的宽度 */
const PANE_GAP = 320
/** 功能面板盖在对话上时（窄屏抽屉、pane 里）的宽度：覆盖态没有并排可拖，按原来的定宽铺开 */
const REPORT_COVER_WIDTH = 440
/** 功能面板比文件面板窄：评审卡片里是「徽标 + 标题」一行，比文件列表的路径行更省宽度 */
const REPORT_PANE_MIN = 320

/**
 * 右栏的可拖上限：从右栏所在容器的宽度里扣掉中间至少要留的部分，不写死像素。
 * 容器要按自己那一栏量：AI 分析窗口是 Portal 挂在 body 末尾的，背景对话页的右栏同样还挂着，
 * 从 document 里取第一个会量到背景那一页，上限就按错的宽度算（拖动条挂到 max 时才发现拖不动）。
 */
function paneMax(box: HTMLElement | null, min: number) {
  const row = box?.parentElement?.clientWidth ?? window.innerWidth
  return Math.max(min, row - PANE_GAP)
}

/**
 * 对半的栏宽：这台机器上拖过就用拖过的宽度（usePaneWidth 记的），没拖过就是本栏容器的一半
 * （用户 2026-11 要求有功能面板时默认功能面板和对话面板各占一半）。
 *
 * 一半按本栏自己的容器量，不按窗口：AI 分析窗口是弹窗、比窗口窄，侧栏收起时还会更宽。
 * 容器要等任务加载完、右栏真的挂上才有尺寸（见 TaskView 的 setRail），拿到之前先按窗口减掉左栏估算。
 * `rowWidth` 每次现量、不缓存：双击拖动条恢复默认时 usePaneWidth 会重新调一次初值函数，
 * 那时窗口可能已经改过大小，按缓存会回到旧的一半。
 */
function useHalfPane(
  key: string,
  min: number,
  max: () => number,
  rowWidth: () => number,
  rowMounted: boolean,
  /** 默认宽度的上限：文件面板（项目文件 / 本对话改动）不用占一半，给对话留出主体宽度 */
  cap = Infinity,
) {
  const half = () =>
    typeof window === 'undefined'
      ? PANE_DEFAULT_SSR
      : Math.min(cap, paneHalfWidth(rowWidth() || rowWidthFromWindow(window.innerWidth), min))
  const pane = usePaneWidth(key, half, min, max)
  useLayoutEffect(() => {
    // 拖过的宽度原样用：用户的选择优先，量到容器也不会改回去
    if (!pane.stored && rowMounted) pane.fit(half())
    // 右栏挂上、能量出真实容器了才对半一次；窗口 resize 后不自动跟（和文件面板一样，栏宽算用户自己的布局）
    // pane 每次渲染都是新对象，放进依赖会一直重跑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [rowMounted])
  return pane
}

/**
 * 内容没变就沿用原来的数组：子对话栏 4 秒轮询一次，每次都换新数组会让整个对话页（连同几百条消息）重渲染，
 * 子对话一多、消息一长，打字和滚动都会跟着一顿一顿的
 */
function sameJson<T>(cur: T, next: T): T {
  return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
}

/**
 * 本地刚点开过的子对话按已读算：子对话页自己会发 /seen，但 4 秒一次的轮询可能抢在它前面，
 * 把刚消失的未读点又画回来。只覆盖「点开那一刻的那一轮」：服务端换了新的完成时间（它又跑完一轮）时不按已读算，
 * 那一轮归子对话页自己的 /seen 管，不然会和侧栏的橙点对不上
 */
function withLocalSeen(c: ChildSummary, viewed: Map<string, string>): ChildSummary {
  const seenAt = viewed.get(c.id)
  return seenAt && childSeenLocally(c, seenAt) ? { ...c, turnSeenAt: seenAt } : c
}

/** 右栏开着哪个子对话按父任务 id 记在本地：切走窗口、重新加载后还显示原来那个 */

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

/** Chat 页右栏（代码 / 来源 / 附件）收起过就记一笔：所有聊天共用一个开关，默认开着 */
const CHAT_RAIL_KEY = 'chat-rail'
const NO_MESSAGES: TaskMessage[] = []

const readPaneChild = (taskId: string) => readStored(paneChildKey(taskId))
const readPaneRun = (taskId: string) => Number(readStored(paneRunKey(taskId))) || 0
/** 文件面板收没收起按对话记在本地：右栏「项目文件 / 本对话改动」默认开着，用户收起过才记一笔 */
const readFilesFolded = (taskId: string) => readStored(paneFilesKey(taskId)) === 'closed'
const writeFilesFolded = (taskId: string, folded: boolean) => writeStored(paneFilesKey(taskId), folded ? 'closed' : '')
/** 分析对话的功能面板默认开着：用户收起过才记一笔 */
const readReportFolded = (taskId: string) => readStored(paneReportKey(taskId)) === 'closed'
const writeReportFolded = (taskId: string, folded: boolean) =>
  writeStored(paneReportKey(taskId), folded ? 'closed' : '')
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
}) {
  const { agents: localAgents, workflows, settings, upsertTask, removeTask, tasks } = useData()
  const nav = useNav()
  const go: typeof nav.go = (r) => {
    embed?.onLeave()
    nav.go(r)
  }
  const [task, setTask] = useState<TaskPage | null>(null)
  // 从搜索结果点进来时定位到那条消息：消息是异步加载的（被折叠的过程还要先展平），多试几次再放弃。
  // 跳转成功后地址里的 msg 还在，同一个 (对话, 消息) 只定位一次：不然每来一条新消息（条数变了）都会把视图滚回那条旧命中
  const jumpMsg = nav.route.msg
  const anchored = useRef('')
  useEffect(() => {
    if (!jumpMsg || !task) return
    const mark = `${task.id}:${jumpMsg}`
    if (anchored.current === mark) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      if (jumpToMessage(jumpMsg)) {
        anchored.current = mark
        return
      }
      if (++tries >= ANCHOR_TRIES) return
      timer = setTimeout(attempt, ANCHOR_RETRY_MS)
    }
    attempt()
    return () => clearTimeout(timer)
    // 依赖只看 id 和消息条数：整个 task 每个增量都是新对象，按它比会每 200ms 重新定位一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpMsg, task?.id, task?.messages.length])
  // 打开这条对话的加载日志：各步在请求真正发起 / 返回的地方记，界面按它逐行打日志
  const trace = useLoadTrace()
  // 任务数据到了以后日志盖在对话上淡出，淡完就卸载（不一直占着屏幕）
  const [traceHidden, setTraceHidden] = useState(false)
  // 「渲染消息」这一步只记第一次：记下是为哪个任务记的，换对话时不能延用旧的那次结果
  const traceRenderFor = useRef('')
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
  // 输入框里此刻的附件（渲染时同步）：发送时立刻清空，失败要把这次发的那几个放回去，
  // 不能读闭包里的旧列表——那会把刚清空的当成还在，反倒让附件丢了（见 restoreDraft）
  const attachmentsNow = useRef<Attachment[]>([])
  attachmentsNow.current = files.attachments
  // 点发送后先本地插进对话的那几条（待认领）：清空输入框、消息出现都不等接口返回。
  // 单独存、不塞进 task.messages：SSE 推来的整份任务会把它抹掉（见下面画对话时合的 shownTask）
  const [pendingMsgs, setPendingMsgs] = useState<TaskMessage[]>([])
  // 正在往前翻更早的消息（首屏只取了最近一段），按钮上有个进行中的状态
  const [earlierLoading, setEarlierLoading] = useState(false)
  // 打开对话时先 GET 一份（首屏只取最近一段），拿到它再建 SSE：有整份的版本时带上它，
  // 首包就只补发增量；null 表示这一轮还没拿到第一份（GET 还没回来 / 刚换对话）
  const [streamBoot, setStreamBoot] = useState<{ rev: string; task: TaskPage | null } | null>(null)
  const [panel, setPanel] = useState(false)
  // 父对话里的子对话：点开在右栏看，右栏同一时间只显示一个。
  // 右栏开着哪个按父任务 id 记在本地：切走窗口再回来、页面重新加载后还是原来那个
  const [children, setChildren] = useState<ChildSummary[]>([])
  // 子对话列表的重新拉取：首拉、轮询和推送信号都走它（见下面子对话列表的 effect）
  const childrenReload = useRef<(tracked?: boolean) => Promise<void>>(async () => {})
  // 子对话的停下原因只有完整任务上有（/children 给的是摘要）：停下的各取一次，行上才能写清是谁结束的
  // （见 stopReasonText）。停下后原因不会变，取到的记在 ref 里，4 秒一次的轮询不再重复问
  const childStopReasons = useRef(new Map<string, StopReason>())
  /** 在右栏点开过的子对话：点开时那一轮的 turnDoneAt（见 withLocalSeen） */
  const viewedChildren = useRef(new Map<string, string>())
  /**
   * children 的最新一份：openChildRow 用 useCallback 固定了首次渲染的 openChildIn（消息行不跟着重画），
   * 那里直接读 state 会永远是空数组，点开时就记不到这一轮
   */
  const childrenRef = useRef<ChildSummary[]>([])
  childrenRef.current = children
  const loadChildren = useCallback(async (id: string) => {
    const raw = await api.taskChildren(id)
    const finish = (list: ChildSummary[]) => list.map((c) => withLocalSeen(c, viewedChildren.current))
    // 服务端已经给了原因（空字符串是没记）：不用再为每个停下的子对话取一遍完整任务，几十个子对话就是几十份几 MB 的对话
    if (raw.every((c) => c.stopReason !== undefined))
      return finish(raw.map((c): ChildSummary => ({ ...c, stopReason: c.stopReason || undefined })))
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
    return finish(
      list.map((c) => (c.status === 'stopped' ? { ...c, stopReason: childStopReasons.current.get(c.id) } : c)),
    )
  }, [])
  const [openChild, setOpenChild] = useState(() => (pane ? '' : readPaneChild(taskId)))
  // 中间显示父对话还是另一个页签（子对话 / 运行）：页签开着时点父对话页签切回来，页签本身不关。
  // 打开对话时先显示父对话（地址指的就是它），上次开着的子对话 / 运行页签留在页签条上，点了才切过去
  const [onParent, setOnParent] = useState(true)
  /** 右栏当前打开的子对话的最新一份：openChildIn 同样被固定的闭包读，不能直接读 state */
  const openChildRef = useRef('')
  openChildRef.current = openChild
  // 右栏打开的是子对话时，它在自己的 Provider 里读不到父对话的列表和跳转：
  // 这里在组件顶层取外层的值（Provider 之外），标题旁的切换下拉用它，不另取一份数据
  const outerChildren = useContext(ChildListCtx)
  const outerNav = useContext(PaneNavCtx)
  // 宽屏右栏收起：让对话用满整个宽度，收起的按钮还在页签条。默认开着，用户收起过就按本地记着的来
  const [filesFolded, setFilesFolded] = useState(() => readFilesFolded(taskId))
  // AI 分析对话的功能面板（分析报告、教训评审、项目设置）：宽屏是对话右边的一栏，默认开着、收起按对话记住；
  // 窄屏和放在父对话右栏里（pane）时没有地方并排，点标题栏的按钮盖在对话上打开
  const [reportFolded, setReportFolded] = useState(() => readReportFolded(taskId))
  const [reportCover, setReportCover] = useState(false)
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
  const taskPanel = useHalfPane(
    'task-panel',
    PANE_MIN,
    () => Math.max(340, paneMax(rail.current, PANE_MIN)),
    rowWidth,
    railMounted,
    FILES_PANE_CAP,
  )
  // 和文件面板并排在同一栏，但宽度偏好不同，各自记一个（共用 key 会互相改成对方拖过的宽度）
  const reportPane = useHalfPane(
    'report-panel',
    REPORT_PANE_MIN,
    () => paneMax(rail.current, REPORT_PANE_MIN),
    rowWidth,
    railMounted,
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
  const [fileTarget, setFileTarget] = useState<{ path: string; line?: number; local?: boolean } | null>(null)
  const openFile = useCallback((path: string, line?: number) => setFileTarget({ path, line }), [])
  // Chat 页（没有项目的聊天）的右栏：从对话里抽出的代码、来源、附件，都没有时右栏开关禁用
  const chatRail = useChatRail(task?.messages ?? NO_MESSAGES)
  const [chatRailOn, setChatRailOn] = useState(() => readStored(CHAT_RAIL_KEY) !== 'closed')
  const toggleChatRail = () =>
    setChatRailOn((v) => {
      writeStored(CHAT_RAIL_KEY, v ? 'closed' : '')
      return !v
    })
  // 后台命令行的标题点了：在顶层打开这条命令的窗口。挂在页面顶层而不是运行区那一行里，
  // 命令跑完那一行会消失，窗口跟着行卸载的话用户正好看不到最终输出
  const [jobTarget, setJobTarget] = useState<JobTarget | null>(null)
  const openJob = useCallback((job: JobTarget) => setJobTarget(job), [])
  // 盖着文件面板时 Esc 先收面板，不弹停止确认
  useEscape(!!task?.working && !panel && !stopAsk && !openRun && !paneRun, () => setStopAsk(true))
  const [view, setView] = useState<'chat' | 'flow'>('chat')
  // 流程图里选中的节点，右栏只看它
  const [flowSel, setFlowSel] = useState('')
  // 右栏「任务进度」里点了哪一步：切到流程视图并选中它，和点流程图的节点一样
  const [focus, setFocus] = useState<{ id: string; at: number }>()
  // 消息区的贴底：打开就在最新内容，流式输出、工具卡片展开、Markdown 变高都跟着走；
  // 用户往上翻时不打扰，回到底部附近再接着跟。切到流程图视图时这个容器不放对话，停止跟随
  const scroller = useConversationScroll(taskId, view === 'chat')
  const { el: scrollerEl, pin: stickToBottom, unpin: stayPut } = scroller
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
  // 手上这份是不是只有最近一段（见 OPEN_MESSAGE_LIMIT）：从截断恢复到整份时摘要要立刻写
  const truncated = useRef(false)
  const summaryAt = useRef(0)
  const summaryTimer = useRef<number | undefined>(undefined)
  // 列表里的摘要只放第一条用户消息（侧栏预览、搜索都读它）：手上只有最近一段时，消息这一项
  // 沿用列表里已有的那份，别把预览换成尾部那一条；其余字段（未读清掉、状态、子对话计数）照常写，
  // 侧栏马上要反映的变化不能等整份到齐
  const summaryOf = (next: TaskPage): Task =>
    next.messageHasMore
      ? taskSummary(
          windowedForSummary(
            next,
            tasks.find((x) => x.id === next.id),
          ),
        )
      : taskSummary(next)
  const pushSummary = (next: TaskPage, force = false) => {
    const prev = lastTask.current
    lastTask.current = next
    const important =
      force ||
      !prev ||
      prev.id !== next.id ||
      prev.title !== next.title ||
      prev.status !== next.status ||
      prev.working !== next.working ||
      prev.turnDoneAt !== next.turnDoneAt ||
      // 未读清掉（打开对话时）也是侧栏马上要反映的变化，不能等 1 秒节流
      prev.turnSeenAt !== next.turnSeenAt ||
      prev.childrenWorking !== next.childrenWorking ||
      (prev.jobs?.length ?? 0) !== (next.jobs?.length ?? 0) ||
      (prev.requests?.length ?? 0) !== (next.requests?.length ?? 0)
    const now = Date.now()
    if (important || now - summaryAt.current >= 1000) {
      summaryAt.current = now
      if (summaryTimer.current) {
        clearTimeout(summaryTimer.current)
        summaryTimer.current = undefined
      }
      // 全局列表只放摘要，侧栏不用跟着每段输出重新渲染消息
      upsertTask(summaryOf(next))
      return
    }
    if (summaryTimer.current) return
    summaryTimer.current = window.setTimeout(() => {
      summaryTimer.current = undefined
      summaryAt.current = Date.now()
      if (lastTask.current) upsertTask(summaryOf(lastTask.current))
    }, 1000)
  }
  const apply = (raw: TaskPage) => {
    // 数据到手，开始画：渲染这一步从这一刻算到两帧画完（含 React 把消息挂进 DOM 的时间）。
    // 两条路都会经过这里（GET 与 SSE 首包谁先到都可能），所以起始点记在这，不记在某一条请求的 then 里；
    // 已经记过完成的不再改（startStep 对非 waiting 的步骤原样返回）
    trace.start('render')
    // 别的接口顺手返回的任务不带运行时字段：沿用上一份，标题栏和侧栏的转圈不闪（见 keepLiveFields）。
    // 分页信息（messageTotal / messageHasMore）跟着这次那份：转截断了就该能翻页，SSE 整份到了就该收起来
    const next = keepLiveFields(lastTask.current, raw) as TaskPage
    setTask(next)
    // 从「只有一段」恢复到整份：侧栏摘要要立刻换回第一条用户消息，不等 1 秒节流
    const wasTruncated = truncated.current
    truncated.current = !!next.messageHasMore
    pushSummary(next, wasTruncated)
  }
  // 服务端还没给的最早那段（见 OPEN_MESSAGE_LIMIT）：往前翻一页，接在现在的对话前面。
  // 只用它自己那一页的消息，以手上那份为准拼：翻页期间 SSE 可能又推了新消息
  const loadEarlier = async () => {
    const cur = lastTask.current
    const first = cur?.messages[0]?.id
    if (!cur || !first || earlierLoading) return
    setEarlierLoading(true)
    try {
      const raw = await api.task(taskId, { limit: OPEN_MESSAGE_LIMIT, before: first })
      // 锚点那条已经不在（返工删掉了）：不拼一段不连续的历史，重新取最后一页
      if (raw.messageAnchorMissing) {
        apply(await api.task(taskId, { limit: OPEN_MESSAGE_LIMIT }))
        toast(t('对话已经变化，已重新加载'))
        return
      }
      const now = lastTask.current
      if (!now || now.id !== raw.id) return
      const ids = new Set(now.messages.map((m) => m.id))
      const older = raw.messages.filter((m) => !ids.has(m.id))
      // 分页信息跟着这一次的响应走：翻到最后一页时按钮要收起来
      const next = { ...now, messageTotal: raw.messageTotal, messageHasMore: raw.messageHasMore }
      apply(older.length ? { ...next, messages: [...older, ...now.messages] } : next)
      // 用户点了往前走，就把本地那段限长也打开：刚翻回来的这 50 条要能立刻看到，
      // 而不是数据接上了、屏上还只画最后 30 段
      if (older.length) setLimit(Infinity)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setEarlierLoading(false)
    }
  }
  // 服务端只回「这一轮看到哪」（整份对话不再传回来）：合进本地那份，侧栏橙点跟着消失，
  // 未读判定仍在 shared/task 的 taskTurnUnread，这里不改规则
  const applySeen = (seen: TaskSeenResult) => {
    const cur = lastTask.current
    if (cur) {
      const next = withTurnSeenAt(cur, seen.turnSeenAt)
      if (next !== cur) {
        setTask(next)
        pushSummary(next)
      }
      return
    }
    // 首次打开时 /seen 常常比 GET /:id 先回来（那份要序列化整份对话）：这时本地还没有任务，
    // 只能先把全局列表里那条摘要换掉，侧栏橙点不用等整份对话到齐
    const listed = tasks.find((x) => x.id === taskId)
    if (!listed) return
    const patched = withTurnSeenAt(listed, seen.turnSeenAt)
    if (patched !== listed) upsertTask(patched)
  }
  // 子对话标记为已解决：请求走子对话一侧的完成流转（服务端判定 → 置完成 → 上报父对话）。
  // 用户点「解决」时计划里没做完的步骤一并收口（服务端 fromUser 这条路径，见 settleChildForUser），
  // 其余还没收口的东西（这一轮在跑、独立分支没合回、待回答的提问）仍返回 409，把卡在哪一项弹给用户；
  // 已经解决的重复点击不再发请求
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

  // 服务端已经把这条记进对话了（推送或响应到达）：本地那条待认领的退场，显示服务端那一份
  // （两边同一个 id：发送时页面生成、接口传过去，见 api.sendMessage 的 messageId）
  useEffect(() => {
    if (!pendingMsgs.length || !task) return
    const ids = new Set(task.messages.map((m) => m.id))
    const rest = pendingMsgs.filter((m) => !ids.has(m.id))
    if (rest.length !== pendingMsgs.length) setPendingMsgs(rest)
    // 只跟着任务变：pendingMsgs 自己变了不用再筛一遍
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task])

  useEffect(() => {
    // 换对话：日志从头记（同一个组件实例可能被复用），盖住对话的那一层也重新出来
    trace.reset()
    setTraceHidden(false)
    traceRenderFor.current = ''
    // 换了对话：先不建 SSE，等这一条的 GET 回来（避免拿上一条的版本去连）
    setStreamBoot(null)
    truncated.current = false
    trace.start('task')
    // 演示版没有服务端推送，改用轮询：等任务数据到了再按「有没有在跑」判定这一步（见下面的演示版分支）
    if (!import.meta.env.VITE_DEMO) trace.start('stream')
    api
      .task(taskId, { limit: OPEN_MESSAGE_LIMIT })
      .then((raw) => {
        trace.finish('task')
        // SSE 首包可能先到（例如重连过），它带的是整份对话：不能再用只取了最近一段的这份盖回去
        if ((lastTask.current?.messages.length ?? 0) <= raw.messages.length) apply(raw)
        // 拿到第一份再建 SSE：整份都在这一份里时带上版本（服务端首包只补发增量），
        // 并把这一份作为合并增量的基线
        setStreamBoot({ rev: raw.messageRev ?? '', task: lastTask.current ?? raw })
      })
      .catch((e) => {
        // 错误原文照给用户看；后面的步骤标成「未执行」——它们不是卡住了，是没轮到
        trace.fail('task', (e as Error).message)
        trace.abort()
        toast.error((e as Error).message)
        // GET 失败时照旧连 SSE：没有基线也没有版本，服务端会发整份
        setStreamBoot({ rev: '', task: null })
      })
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
    setFilesFolded(readFilesFolded(taskId))
    setReportFolded(readReportFolded(taskId))
    setReportCover(false)
    // 别处（AI 分析窗口「去对话里看」）要在这个对话的右栏打开某个子对话：已经开着的对话页马上切过去
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ parentId: string; childId: string }>).detail
      if (d?.parentId !== taskId) return
      // 先刷新子对话列表：刚开的子对话还不在列表里，直接切过去会被「已经不在」那条判断清掉
      void loadChildren(taskId)
        .then((list) => setChildren((cur) => sameJson(cur, list)))
        .catch(() => {})
        .finally(() => {
          setOpenChild(d.childId)
          setOpenRun(0)
        })
    }
    const onShowParent = (e: Event) => {
      if ((e as CustomEvent<string>).detail === taskId) setOnParent(true)
    }
    window.addEventListener(OPEN_CHILD_EVENT, onOpen)
    window.addEventListener(SHOW_PARENT_EVENT, onShowParent)
    return () => {
      window.removeEventListener(OPEN_CHILD_EVENT, onOpen)
      window.removeEventListener(SHOW_PARENT_EVENT, onShowParent)
    }
    // 只在换了对话时重新挂：loadChildren 每次渲染都是同一份逻辑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, pane])

  // 文件面板的开合：按对话记在本地，下次打开还是用户最后一次选的那样。子对话自己的右栏（pane）不写
  const toggleFiles = () => {
    setFilesFolded(!filesFolded)
    if (!pane) writeFilesFolded(taskId, !filesFolded)
  }
  // 右栏切换的统一入口：记在本地，下次打开还是这一栏。子对话自己的右栏（pane）不写
  const openChildIn = (id: string) => {
    // 点开就算读过：只记点开这一拍的那一轮，用来挡住 4 秒轮询把刚消失的未读点画回来；
    // 它之后又跑完的新一轮不归这里管——那一轮由子对话页自己的 /seen 记，这里跟着轮询更新的话
    // 会和侧栏的橙点对不上（服务端还没看过，父对话列表却当成看过了）。
    // 右栏已经开着这一个时（id 没变）也不清点：pane 不重挂载就不会再发 /seen，
    // 本地当成看过而服务端还记着没看，刷新后点又回来
    const viewed = id && id !== openChildRef.current ? childrenRef.current.find((c) => c.id === id) : undefined
    if (viewed?.turnDoneAt) {
      viewedChildren.current.set(id, viewed.turnDoneAt)
      // 当前这份列表立刻按已读显示，不用等下一次轮询：换开别的子对话后这条不再被 viewing 挡住
      setChildren((cur) => cur.map((c) => withLocalSeen(c, viewedChildren.current)))
    }
    setOpenChild(id)
    if (id) setOpenRun(0)
    if (id) setOnParent(false)
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
    if (run) setOnParent(false)
    writePaneRun(taskId, run)
  }
  // 子对话面板里点「启动工作流」这一行：认回它启动的是第几次运行，就地打开那次运行的视图
  const openPaneRun = (tool: ToolUse) => setPaneRun({ run: task ? (startedRun(task, tool) ?? 0) : 0, tool })

  // 子对话列表：父对话页开着时定时刷新状态和摘要；子对话自己不显示子对话。
  // 这里只是只读查询，不给子对话发 presence、也不预热它们的 CLI
  useEffect(() => {
    // 任务还没拿到时不动：这一步是「还没轮到」，不是「没有子对话」
    if (!task?.id) return
    if (task.parentTaskId) {
      setChildren([])
      // 子对话自己没有子对话列表：这步按「不适用」处理，日志才能走完
      trace.skip('children', t('这个对话没有子对话'))
      return
    }
    let alive = true
    // 只有第一次拉取记进加载日志：后面的轮询和「打开对话」无关
    const load = (tracked = false) => {
      if (tracked) trace.start('children')
      return loadChildren(task.id)
        .then((list) => {
          if (alive) setChildren((cur) => sameJson(cur, list))
        })
        .catch((e) => {
          if (tracked) trace.fail('children', (e as Error).message)
        })
        .finally(() => {
          if (tracked) trace.finish('children')
        })
    }
    // 轮询和推送信号都走同一个函数（下面的 effect 拿不到这个闭包）
    childrenReload.current = load
    void load(true)
    return () => {
      alive = false
      childrenReload.current = async () => {}
    }
    // 任务 id 变了才重新订阅；子对话的变化靠下面的轮询和推送信号
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.parentTaskId])
  // 子对话列表的轮询间隔：没有子对话就一次也不发（子对话产生时由推送的统计数和上报信号拉回来，见下）。
  // 有子对话时按有没有在跑分两档：都在跑 4 秒，都静止 15 秒——静态的子对话只是等它再动，
  // 每 4 秒问一遍服务端（每个子对话还要跑一次 git）就是纯空转
  const childrenWorking = children.some(childSpinning)
  useEffect(() => {
    if (!task?.id || task.parentTaskId || !children.length) return
    const timer = setInterval(
      () => void childrenReload.current(),
      childrenWorking ? CHILD_POLL_ACTIVE_MS : CHILD_POLL_IDLE_MS,
    )
    return () => clearInterval(timer)
  }, [task?.id, task?.parentTaskId, children.length, childrenWorking])
  // 子对话那边变了就重取子对话列表：待选择的提问变了（在子对话里选完、交给父对话决定），
  // 或者收到子对话的上报（panel === 'child'，含「子对话已完成」）。
  // 名下子对话的计数（childrenWorking / childrenCli）变了也要重取：子对话刚开、刚跑完的时候
  // 任务本身不一定会推新消息，靠这两个数把列表拉回来
  // 列表只读子对话自己的状态、本地不改写：子对话先置完成并上报，这里才跟着变，不抢在它前面
  const childSignal = task?.parentTaskId
    ? ''
    : [
        (task?.messages ?? []).filter((m) => m.panel === 'child').at(-1)?.id ?? '',
        ...(task?.messages ?? [])
          .filter((m) => m.panel === 'ask' && m.ask?.answer === undefined && !m.ask?.delegated)
          .map((m) => m.id),
      ].join(',')
  const childScan = `${task?.childrenWorking ?? 0}|${task?.childrenCli ?? 0}`
  const childSignalSeen = useRef({ taskId: '', key: '' })
  useEffect(() => {
    if (!task?.id || task.parentTaskId) return
    const key = `${childSignal}|${childScan}`
    const seen = childSignalSeen.current
    // 换到另一条对话（或第一次）：只记下当前的信号，首拉已经在上面那次 effect 里做了
    if (seen.taskId !== task.id) {
      childSignalSeen.current = { taskId: task.id, key }
      return
    }
    if (seen.key === key) return
    childSignalSeen.current = { taskId: task.id, key }
    void childrenReload.current()
    // 只在子对话那边的状态有变化（上报、提问状态、子对话计数）时刷新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [childSignal, childScan, task?.id, task?.parentTaskId])

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
    trace.start('seen')
    api
      .markTaskSeen(taskId)
      .then((seen) => {
        trace.finish('seen')
        applySeen(seen)
      })
      // 标记已读失败不影响看对话：只在日志里标红并显示原文，不弹提示
      .catch((e) => trace.fail('seen', (e as Error).message))
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
        .then(applySeen)
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
  // 还列着后台命令（等结果）时也要跟数据：命令跑完那一刻它从 jobs 里消失，
  // 不刷新的话界面上那一行会一直挂着「执行中」。正式版靠 SSE 推送，这里主要是演示版的轮询口径
  const jobRunning = (task?.jobs ?? []).some((j) => j.state === 'queued' || j.state === 'running')
  // 演示版把轮询当作实时更新来记：按「打开那一刻有没有在跑」判定一次，之后任务再开始 / 停下不重记
  // （加载日志记的是这次打开；startStep / skipStep 都只对 waiting 生效，跟着 running 反复切换会卡在旧状态）。
  // 轮询自己的起停由 useTaskStream 的 start / stop 包住：打开时在跑、首轮回来前就停了，也会被收回来
  const demoTraceStream = useRef('')
  useEffect(() => {
    if (!import.meta.env.VITE_DEMO || !task) return
    if (demoTraceStream.current === task.id) return
    demoTraceStream.current = task.id
    if (running || jobRunning) trace.start('stream')
    else trace.skip('stream', t('这条对话没有实时更新'))
    // 只在任务到的第一刻判一次；trace 的函数是稳定的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, running, jobRunning])
  useTaskStream(
    taskId,
    running || jobRunning,
    apply,
    {
      // 演示版把轮询当作实时更新：轮询在跑才算这一步开始，停下时收回来（正式版走 SSE，不调这两个）
      start: () => trace.start('stream'),
      stop: () => trace.finish('stream', t('实时更新已停止')),
      // 首包到了：正常首包直接完成；之前失败过一次又重连上的，把那条失败收回来
      // （否则重连成功后面板会永久停在「加载失败」，对话其实已经好了）
      open: () => {
        trace.recover('stream', t('重新连上了'))
        trace.finish('stream')
      },
      fail: (error) => trace.fail('stream', error),
    },
    streamBoot,
  )

  // 任务创建时存下的工作流；现在的版本改过时，可以选择按新的继续
  const workflow = task ? taskWorkflows(task, workflows).workflow : undefined
  const latestWf = workflows.find((w) => w.id === task?.workflowId)
  const wfChanged = !!task?.workflows.length && !!latestWf && latestWf.updatedAt !== workflow?.updatedAt
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
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

  // 分析报告在哪条回复里：画在右侧的功能面板，不再铺在对话区（用户 2026-10-25 要求，ADR 0016）
  const report = useMemo(() => (task ? findReport(task) : null), [task])
  const reportId = report?.message.id ?? ''
  // 出了新的报告（重新分析、接着追问后又出了一份）：收起过的面板重新打开
  const seenReport = useRef(reportId)
  useEffect(() => {
    const prev = seenReport.current
    seenReport.current = reportId
    if (!reportId || !prev || reportId === prev) return
    setReportFolded(false)
    if (!pane) writeReportFolded(taskId, false)
    // 只跟着报告换了没有走
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId])
  useEscape(reportCover, () => setReportCover(false), true)

  // 对话里要画的消息：服务端那份加上还没被服务端接收的（待认领）。其余地方读的还是服务端的 task
  const shownTask = useMemo(() => {
    if (!task || !pendingMsgs.length) return task
    const ids = new Set(task.messages.map((m) => m.id))
    const fresh = pendingMsgs.filter((m) => !ids.has(m.id))
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

  // 消息真的画到屏幕上才算「渲染完成」：两帧之后记，第一帧 React 把消息写进 DOM，第二帧浏览器画出来。
  // 认任务 id：两条对话切得很快、或者消息还在增量推送时，旧的那次 rAF 不能把后一条记成已渲染
  useEffect(() => {
    if (!task || traceRenderFor.current === task.id) return
    const id = task.id
    const count = task.messages.length
    traceRenderFor.current = id
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (traceRenderFor.current !== id) return
        trace.finish('render', t('{n} 条消息', { n: count }))
      }),
    )
    // 只跟着任务 id；同一条对话的消息增量不重记；trace 的函数是稳定的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task])

  if (!task)
    return (
      <main className={cn('flex flex-1 items-center justify-center text-subtle', !pane && !embed && 'panel')}>
        <LoadTrace steps={trace.steps} />
      </main>
    )

  // Chat 模式的聊天不属于项目：没有可看的项目文件，右边的文件栏和展开按钮都不显示
  const noFiles = !task.projectId
  // Chat 页的聊天换成自己的标题栏和右栏（Chat.dc.html）；项目里的对话照旧用页签条。
  // 聊天派出了子对话或开着运行页签时也退回页签条，那些页签要有地方放
  const chatPage = noFiles && !pane && !embed && task.mode === 'chat' && !children.length && !openRun
  // 这一轮没在跑时到底在等什么：等后台命令、等子任务、等工作流，还是真停在等下一句。
  // 统一用 shared/task 的 childWait（子对话栏、交给父对话的上报用的是同一个），不在这里另写一套
  // 「有没有东西在跑」——以前只看 awaitingUser，子任务还在跑也写「等待你的下一条消息」
  const chatWait =
    task.mode === 'chat' ? childWait(task, { background: task.jobs?.length, cliAlive: task.cliAlive }) : undefined
  // 功能面板占右栏（宽屏）：和文件面板同一栏，同一时间只显示一个
  const reportOn = !!report && !pane && !reportFolded
  // 中间正显示子对话或运行页签（父对话藏起来）
  const showOther = !pane && !onParent && (!!openChild || openRun > 0)
  const closeReport = () => {
    if (reportCover) return setReportCover(false)
    setReportFolded(true)
    if (!pane) writeReportFolded(taskId, true)
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
  const send = async (input?: string) => {
    const text = input ?? followTa.current?.text() ?? ''
    if (!text.trim() && !files.attachments.length) return
    // 输入框已经拦过一道（Enter 和按钮同一个 ready）：这里再拦一次，并说清原因，不默默丢掉用户写的字
    if (sending || files.uploading) {
      toast.info(
        files.uploading ? t('附件还在{status}，稍等一下', { status: files.waiting }) : t('上一条还在发送，稍等一下'),
      )
      return
    }
    const content = forSend(expandQuotes(text, files.attachments), files.attachments.length ? ATTACHMENT_PROMPT : '')
    if (!files.items.length && slash.intercept(content)) return
    // 发出去的这一刻就清空输入框、把消息插进对话。清空不能等接口返回：服务端这条的响应要等
    // settings、项目、git/p4 探测、CLI 拉起这一串（消息本身早已经 SSE 到界面），
    // 以前就是在这里 await 完才清空，于是出现「气泡已经标了已交给 Agent、输入框还满着」
    const attachments = files.attachments
    const messageId = crypto.randomUUID()
    const pending: TaskMessage = {
      id: messageId,
      role: 'user',
      agentId: '',
      step: '',
      text: content,
      tools: [],
      ...(attachments.length ? { attachments } : {}),
      // 面板还没接收、Agent 还没认领；服务端记下这条后换成「已交给 Agent，这一轮接着处理」
      delivery: { how: 'pending', at: new Date().toISOString() },
      at: new Date().toISOString(),
    }
    setPendingMsgs((xs) => [...xs, pending])
    followTa.current?.setText('')
    files.clear()
    // 这次发的已经清掉了：失败时只把这几个放回去，用户在这几秒里新加的不用跟着猜
    attachmentsNow.current = []
    stickToBottom()
    setSending(true)
    try {
      const sent = await api.sendMessage(task.id, content, attachments, false, messageId)
      apply(sent)
      // 面板自己处理的命令（例如 /rule 发布全局规则）不把这条记进对话：服务端返回的对话里没有这个 id，
      // 本地那条「待认领」要撤掉，否则会一直挂在对话里（只有切走或刷新才消失）
      if (!messageRecorded(sent.messages, messageId)) setPendingMsgs((xs) => xs.filter((m) => m.id !== messageId))
      setTimeout(
        () =>
          api
            .task(task.id)
            .then(apply)
            .catch(() => {}),
        200,
      )
    } catch (e) {
      // 请求失败不等于没发出去：服务端可能已经收下并推到了界面（消息上已经写着「已交给 Agent」），
      // 只是响应因连接中断没回来。先确认这条有没有被服务端记下，记下了就别把原文又放回输入框
      // （那正是用户报的「消息发出去了、输入框里字还在」，用户再回车会再发一条一样的）
      const landed = await landedMessage(task.id, messageId)
      if (deliveredToCli(landed)) {
        toast.error((e as Error).message)
        return
      }
      // 没发出去（或服务端自己标了「没送出去」）：本地那条撤回，原文和附件放回输入框，
      // 不能既没发出又把用户写的字弄丢
      setPendingMsgs((xs) => xs.filter((m) => m.id !== messageId))
      restoreDraft(text, attachments)
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  /**
   * 这条消息服务端记下来没有：先看本地（SSE 可能已经推到了），再问一次服务端。
   * 请求报错时用它决定是把原文放回输入框还是只提醒一次
   */
  async function landedMessage(id: string, messageId: string) {
    const local = lastTask.current?.messages.find((m) => m.id === messageId)
    if (local) return local
    return api
      .task(id)
      .then((t) => t.messages.find((m) => m.id === messageId))
      .catch(() => undefined)
  }
  // 发送失败时把原文、附件放回输入框：输入框已经空了就原样放回，用户已经接着写了就接在他写的内容后面，
  // 两种情况都不能让他刚写的东西丢掉。用函数声明：send 在上面引用它，事件触发时它已经定义
  function restoreDraft(text: string, attachments: Attachment[]) {
    const ed = followTa.current
    const cur = ed?.text() ?? ''
    ed?.setText(cur.trim() ? `${cur}\n\n${text}` : text)
    if (attachments.length) {
      // 这次发的和用户刚加的可能有重叠（同一个文件重新加过）：按路径去重，不重复摆两张卡片
      const extra = attachmentsNow.current.filter((a) => !attachments.some((x) => x.path === a.path))
      files.replace([...extra, ...attachments])
    }
    ed?.focus()
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
      toast.success(t('已强制停止，Agent 进程已结束'))
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
  // 改名输入框（InlineRename）交回最终的值；renaming 只记「正在改、从哪个标题开始改」
  const rename = async (value: string) => {
    const title = value.trim()
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
      toast.success(t('已移进回收站，{days} 天内可以恢复', { days: TRASH_RETENTION_DAYS }))
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
  // 这一轮已说完、名下还有东西在跑（子对话 / 子任务 / 后台命令 / 工作流）：输入框只说「继续输入要求」
  // 会和旁边的停止按钮自相矛盾——用户看到的是「子对话在跑，父对话却停在等继续」。
  // 让它说清到底在等什么
  const waitText = !working ? taskWaitText(task) : ''

  const exportIt = () =>
    downloadTask(task.id).then(
      ({ children }) =>
        toast.success(
          children ? t('已导出任务和 {n} 个子对话，导入后父子结构能还原', { n: children }) : t('已导出任务'),
        ),
      (e: Error) => toast.error(e.message),
    )
  /**
   * 导出成单文件 HTML：接收方没装面板也能看，样式内联、不执行脚本（见 shared/task-export.ts 的 taskHtml）。
   * 和 JSON 包分开两项：一个是给别人看的报告，一个是导回面板的数据
   */
  const exportHtml = () =>
    downloadTaskHtml(task.id).then(
      () => toast.success(t('已导出 HTML 报告，用浏览器直接打开就能看')),
      (e: Error) => toast.error(e.message),
    )
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
  const askOpen = (task.parentAsks ?? []).length > 0 && !task.imported && !asksQuestion(task.requests)
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
            // 只有父对话有「子对话也提问」：子对话页面不传回调，右键菜单不出现
            childAskUser={task.childAskUser}
            onChildAskUserChange={
              task.parentTaskId
                ? undefined
                : (on, applyExisting) => {
                    api
                      .setTaskChildAskUser(task.id, on, applyExisting)
                      .then(apply, (e) => toast.error((e as Error).message))
                  }
            }
          />
          {/* Chat 页的 CLI 和模型挪到标题栏，输入框里只留思考强度 */}
          {byCli && <ChatModelPicker value={chatRun} onChange={changeRun} parts={chatPage ? 'effort' : 'all'} />}
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
      // 对话还在运行（自己在跑，或者子对话、子任务、后台命令、工作流还没完）就是停止按钮：
      // 停止会把这些附属的一起停掉（见服务端 /stop），判定和标题栏、侧栏同一个（taskActive）
      running={working || taskActive(task)}
      // 正在发送上一句：Enter 和按钮一起拦住，并给一句提示（见 ChatComposer 的 blocker）
      sending={sending}
      onStop={stop}
      leading={
        // 还在等名下的东西跑完时不放「继续执行」：那一轮不是「被中断」，再拉起一遍会和还在跑的子对话重复。
        // 只挡「已停止」这一种：失败时「重试」是用户主动重跑，哪怕子对话还在跑也要能点
        !working &&
        !(task.status === 'stopped' && waitText) &&
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
          ? waitText
            ? t('{what}，可以直接输入要求', { what: waitText })
            : t('继续输入要求')
          : canSteer
            ? t('执行中也可以输入：相关的会调整当前方向，无关的等这一轮完成后再处理')
            : t('执行中也可以输入，这一轮结束后接着处理')
      }
    />
  )

  // 对话页的停靠区：计划贴在输入框上方、在消息流外面，不跟着滚，也不插在用户消息和回复之间。
  // 子任务、子对话不在这里列：消息流的运行区和对话页签里已经有，这里再放一行会把输入框往下挤
  const conversationDock = (
    <>
      {/* 面板收起后还在跑的后台步骤（实时更新、子对话列表）：留一个小胶囊，失败时写错误原文 */}
      {traceHidden && <LoadTracePill steps={trace.steps} />}
      {task.plans?.length > 0 && (
        <div className="shrink-0 px-3 md:px-6">
          {/* 计划条撑满输入框宽度（组件库「计划 · PlanBar」）：浅底一整条，和输入框左右对齐 */}
          <div className="mx-auto max-w-(--content-w)">
            <div data-status-row="plan" className="mb-1.5 flex min-w-0 flex-nowrap">
              <PlanButton task={task} children={children} />
            </div>
          </div>
        </div>
      )}
      <div className="shrink-0 px-3 pt-1 pb-3 md:px-6 md:pb-5">
        <TaskRequestCard task={task} onAnswered={apply} />
        {askOpen && <ParentAskPanel task={task} onClosed={apply} />}
        <WorktreeBar task={task} />
        {flowLeft && !task.imported && (
          <FlowBar task={task} blocked={blocked} resuming={resuming} onResume={() => resume()} onChange={apply} />
        )}
        {task.imported && <ImportedBar task={task} onAnalyze={() => setAnalyzing(true)} />}
        {/* 点开运行面板、子对话里就地打开运行时输入框挪进去，这里先空着，避免出现两个输入框 */}
        {!(showOther && openRun) && !paneRun && composer}
        {/* 上下文、Token 用量和环境放在输入框下面，右栏留给文件系统 */}
        <TaskMeta
          task={task}
          projectName={project?.name}
          projectPath={project?.path}
          workflowName={task.mode === 'workflow' ? (workflow?.name ?? t('已删除的工作流')) : undefined}
          node={isFlow ? task.steps.find((s) => s.id === flowSel) : undefined}
          onTask={apply}
          // 子对话自己的面板里不再套一层右栏
          onOpenChild={pane ? undefined : openChildIn}
        />
      </div>
    </>
  )

  // 标题区（面包屑、状态、标题）和操作按钮：父对话放进页签条（标题是父对话页签、按钮在页签条右端），
  // 中间打开的子对话沿用原来的标题栏
  // 进程菜单、模拟 / 导入标记：子对话在标题后面，父对话在页签条右端
  const headerBadges = (
    <>
      <ProcessMenu taskId={task.id} />
      {!isFlow && <TurnMenu msgs={task.messages} onJump={jumpToTurn} />}
      {task.simulated && (
        <Badge tone="warning" title={t('没有真正调用 Agent，输出是示例')} className="hidden shrink-0 md:inline-flex">
          <FlaskConical className="h-3 w-3" />
          {t('模拟')}
        </Badge>
      )}
      {task.imported && (
        <Badge tone="accent" title={t('从导出的文件导入，只能查看')} className="hidden shrink-0 md:inline-flex">
          <FileInput className="h-3 w-3" />
          {t('导入')}
        </Badge>
      )}
    </>
  )
  // 标题（双击改名）：对话页签条里、子对话面板的标题栏、Chat 页的标题栏共用
  const titleNode = (
    <>
      {renaming !== null ? (
        <InlineRename
          value={renaming}
          label={t('任务标题')}
          onCommit={rename}
          onCancel={() => setRenaming(null)}
          className="flex-1 font-medium"
        />
      ) : (
        <>
          {isAnalysisTask(task, localAgents) && <AnalysisMark kind={task.analysis} className="ml-1" />}
          {/* 对话（或名下子对话）有活着的 CLI：标题上流过一道高光，CLI 关了就没有 */}
          <h2
            title={[cliAliveHint(task), t('双击重命名')].filter(Boolean).join(' · ')}
            onDoubleClick={() => setRenaming(task.title)}
            className={cn('min-w-0 truncate px-1 font-medium', cliTreeAlive(task) && 'cli-alive-title')}
          >
            {task.title}
          </h2>
        </>
      )}
    </>
  )
  const headerNav = (
    <nav aria-label={t('位置')} className="flex min-w-0 flex-1 items-center gap-1 text-[0.8125rem]">
      {/* 右栏打开子对话：标题左边给一个下拉，和消息流里的入口一样列出父对话的全部子对话，
          点一项就地切换；列表中用外层（父对话）的那份数据，当前这一项带勾选 */}
      {pane && task.parentTaskId && outerNav?.child && (
        <ChildSwitcher list={outerChildren} current={task.id} onOpen={(id) => outerNav?.child?.(id)} className="ml-1" />
      )}
      {/* 标题前的状态和侧栏、项目首页同一个判定（taskState）：自己在跑、在等子对话 / 子任务 /
          后台命令 / 工作流都转圈，有没回复的提问、请求换成提问图标 */}
      <TaskStatusIcon
        status={task.status}
        working={taskBusy(task)}
        spin={taskBusy(task)}
        waiting={taskState(task) === 'needs'}
        label={taskWaitText(task) || undefined}
        className="ml-1"
      />
      {titleNode}
      {headerBadges}
    </nav>
  )
  const headerActions = (
    <>
      {task.mode === 'workflow' && (
        // 样子同 Segmented（seg-track / seg-thumb），但窄屏只留图标，Segmented 没有这种响应式写法，先手写
        <div className="seg-track flex shrink-0 rounded-lg p-0.5" role="tablist" aria-label={t('视图')}>
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
                view === v ? 'seg-thumb' : 'text-muted hover:text-fg',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', v === 'flow' && 'rotate-90')} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      )}
      {task.mode === 'workflow' && tops.length > 0 && (
        <IconButton
          size="sm"
          icon={ListPlus}
          label={t('任务进度')}
          aria-expanded={progressOpen}
          onClick={() => setProgressOpen((v) => !v)}
        />
      )}
      {/* 窄屏右栏放不下：文件面板从右边滑出来盖在对话上 */}
      {!pane && !noFiles && (
        <IconButton
          size="sm"
          icon={PanelRight}
          label={t('显示文件')}
          title={t('文件')}
          onClick={() => setPanel(true)}
          className="xl:hidden"
        />
      )}
      {/* 子对话面板右上角的「解决」：标记为已解决，记录、分支和未提交改动都保留；已经解决时换成标记 */}
      {pane &&
        task.parentTaskId &&
        (task.resolved ? (
          <StatusPill tone="ok" title={t('已解决')}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('已解决')}
          </StatusPill>
        ) : (
          <IconButton
            size="sm"
            label={t('解决')}
            disabled={resolving}
            onClick={() => void resolveChild()}
            // 默认隐起来（opacity-0），鼠标进标题栏或 Tab 聚焦才显示；
            // 没有 hover 的设备（触屏、平板）常显，否则根本点不到
            className="opacity-0 group-hover/hdr:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <CheckCircle2 className="h-4 w-4" />
          </IconButton>
        ))}
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="sm" label={t('更多操作')}>
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
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
          <MenuItem onSelect={exportIt} title={t('连同它分出的子对话一起导出，导入后父子结构能还原')}>
            <Download className="h-4 w-4" />
            {t('导出任务')}
          </MenuItem>
          <MenuItem onSelect={exportHtml} title={t('导出一个自包含的 HTML 文件，没装面板的浏览器也能直接打开')}>
            <FileCode2 className="h-4 w-4" />
            {t('导出 HTML 报告')}
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
      {/* 转成弹窗：把当前对话收成右下角的浮条，页面回到上一级。
          只在对话页本体上给：右栏子对话（pane）、AI 窗口里嵌的（embed）不需要——
          右栏本来就在对话旁边、AI 窗口自己已经有最小化按钮；导入的任务只能看，不收。
          子对话也不给：浮条的状态和标题靠 useData().tasks 找对话，而 /tasks 列表
          只回顶层对话（见 server/tasks.ts），子对话收起来会一出现就写「对话已关闭」。 */}
      {!pane && !embed && !task.imported && !task.parentTaskId && (
        <IconButton
          size="sm"
          label={t('转成弹窗')}
          title={t('转成弹窗（对话继续在后台运行）')}
          onClick={() => {
            minimizeTask({ id: task.id, projectId: task.projectId || undefined })
            // 和 AI 窗口的“去对话里看”相反：收起后回上一级，不同时显示对话页和浮条
            go(minimizeBackRoute({ projectId: task.projectId || undefined }))
          }}
        >
          <PictureInPicture2 className="h-4 w-4" />
        </IconButton>
      )}
      {/* AI 分析对话的功能面板：宽屏切到右栏（子对话、运行开着时先收起它们），窄屏和子对话面板里盖在对话上 */}
      {report && !pane && (
        <ToggleIconButton
          size="sm"
          icon={ClipboardList}
          className="hidden xl:grid"
          label={reportTitle(report.kind)}
          title={reportOn ? t('收起功能面板') : reportTitle(report.kind)}
          pressed={reportOn}
          onPressedChange={() => {
            if (reportOn) return closeReport()
            setReportFolded(false)
            writeReportFolded(taskId, false)
          }}
        />
      )}
      {report && (
        <ToggleIconButton
          size="sm"
          icon={ClipboardList}
          className={pane ? undefined : 'xl:hidden'}
          label={reportTitle(report.kind)}
          pressed={reportCover}
          onPressedChange={setReportCover}
        />
      )}
      {/* 宽屏右栏一直占着位置，这个按钮把文件面板收起来，让对话用满整个宽度 */}
      {!pane && !noFiles && (
        <IconButton
          size="sm"
          className="hidden xl:grid"
          // 收起时和窄屏那个按钮一样：读屏名是「显示文件」、悬停提示「文件」（两者都指同一栏）
          label={filesFolded || reportOn ? t('显示文件') : t('收起文件面板')}
          title={filesFolded || reportOn ? t('文件') : t('收起文件面板')}
          aria-expanded={!filesFolded && !reportOn}
          onClick={() => {
            // 功能面板占着右栏：收起它换成文件
            if (reportOn) {
              setReportFolded(true)
              writeReportFolded(taskId, true)
              if (filesFolded) toggleFiles()
              return
            }
            toggleFiles()
          }}
        >
          {filesFolded || reportOn ? <PanelRight className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
        </IconButton>
      )}
      {embed?.actions}
    </>
  )

  // Chat 页（没有项目的聊天）的标题栏（Chat.dc.html）：标题，右边「Agent · 模型」、导出、开关右栏
  const chatRailShown = chatPage && chatRailOn && !chatRail.empty && !reportOn && !reportCover
  const chatHeader = (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-1.5 border-b px-3 transition-colors md:pl-4',
        scrolled ? 'border-line' : 'border-transparent',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 text-[0.875rem] [&_h2]:font-semibold">
        <TaskStatusIcon
          status={task.status}
          working={taskBusy(task)}
          spin={taskBusy(task)}
          waiting={taskState(task) === 'needs'}
          label={taskWaitText(task) || undefined}
          className="shrink-0"
        />
        {titleNode}
        {headerBadges}
      </div>
      {/* 不用角色的聊天在这里换 CLI 和模型（思考强度留在输入框里）；用了角色的只写是谁在回答 */}
      {byCli ? (
        <ChatModelPicker value={chatRun} onChange={changeRun} parts="run" />
      ) : (
        <span className="min-w-0 truncate px-2 text-xs text-subtle">{chatLabel}</span>
      )}
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="sm" label={t('导出')}>
            <Upload className="h-4 w-4" />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={exportHtml} title={t('导出一个自包含的 HTML 文件，没装面板的浏览器也能直接打开')}>
            <FileCode2 className="h-4 w-4" />
            {t('导出 HTML 报告')}
          </MenuItem>
          <MenuItem onSelect={exportIt} title={t('连同它分出的子对话一起导出，导入后父子结构能还原')}>
            <Download className="h-4 w-4" />
            {t('导出任务')}
          </MenuItem>
        </MenuContent>
      </Menu>
      {headerActions}
      <ToggleIconButton
        size="sm"
        icon={PanelRight}
        label={t('开关右栏')}
        // 三样都没有时禁用，悬停说明为什么点不了
        title={chatRail.empty ? t('这段聊天里还没有代码、来源或附件') : chatRailShown ? t('收起右栏') : t('打开右栏')}
        pressed={chatRailShown}
        disabled={chatRail.empty}
        onPressedChange={toggleChatRail}
        // 右栏只在宽屏并排（窄屏放不下第二栏），开关跟着只在宽屏出现
        className="hidden xl:grid"
      />
    </header>
  )

  return (
    <WithAgents agents={agents}>
      <FileOpenCtx.Provider value={openFile}>
        {/* 子对话（右栏面板或单独打开）里点「启动工作流」：就地换成这次运行的视图，下面带着输入框 */}
        <PaneNavCtx.Provider
          value={
            pane || task.parentTaskId
              ? { runTool: openPaneRun, runView: openRunIn, openChild, job: openJob }
              : { child: openChildRow, runView: openRunIn, openChild, job: openJob }
          }
        >
          <ChildListCtx.Provider value={children}>
            <div
              className={cn(
                'relative flex min-w-0 flex-1',
                pane ? 'h-full min-h-0' : 'min-h-[70vh] md:h-full md:min-h-0',
                // 对话和右栏各是一块面板（见 index.css 的 panel），中间露出一道底色
                !pane && !embed && 'md:gap-2',
              )}
            >
              <main
                ref={setDropArea}
                className={cn('relative flex min-w-0 flex-1 flex-col bg-bg md:h-full', !pane && !embed && 'panel')}
              >
                {/* 打开对话的加载日志：数据到了先盖在对话上，走完停一会儿再淡出（不挡下面的对话） */}
                {!traceHidden && <LoadTrace overlay steps={trace.steps} onHidden={() => setTraceHidden(true)} />}
                {/* 从外面把文件拖到对话页任何位置都算引入到要求里；右栏和流程图有自己的拖拽语义，不在范围内 */}
                {dropOver && <DropOverlay />}
                {chatPage ? (
                  chatHeader
                ) : pane ? (
                  <header
                    className={cn(
                      // group/hdr：标题栏右侧的「解决」按钮默认隐起来，鼠标进到标题栏或 Tab 聚焦时才显示
                      'group/hdr flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-colors md:px-5',
                      scrolled ? 'border-line' : 'border-transparent',
                    )}
                  >
                    {headerNav}
                    {headerActions}
                  </header>
                ) : embed?.slot && !showOther ? (
                  createPortal(
                    <>
                      {headerBadges}
                      {headerActions}
                    </>,
                    embed.slot,
                  )
                ) : (
                  <ConversationTabs
                    task={task}
                    child={children.find((c) => c.id === openChild)}
                    runName={task.workflowName || workflow?.name}
                    openChild={openChild}
                    openRun={openRun}
                    front={showOther ? 'other' : 'parent'}
                    renaming={renaming}
                    onRenaming={setRenaming}
                    onRename={rename}
                    onParent={() => setOnParent(true)}
                    onOther={() => setOnParent(false)}
                    onCloseChild={() => openChildIn('')}
                    onCloseRun={() => openRunIn(0)}
                    mark={isAnalysisTask(task, localAgents) ? <AnalysisMark kind={task.analysis} /> : undefined}
                    trailing={
                      <>
                        {headerBadges}
                        {headerActions}
                      </>
                    }
                  />
                )}

                {/* 父对话本身：中间换成子对话或运行页签时只是藏起来，切回来滚动位置、输入框里的字都还在 */}
                <div className={cn('relative flex min-h-0 flex-1 flex-col', showOther && 'hidden')}>
                  <ConversationShell
                    scroller={scroller}
                    overlay={
                      progressOpen && (
                        <div className="absolute top-3 left-3 z-20 w-[min(340px,calc(100%-1.5rem))] md:left-4">
                          <TaskPanel task={task} onStep={openStep} className="shadow-pop" />
                        </div>
                      )
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
                    dock={conversationDock}
                  >
                    {(hidden > 0 || task.messageHasMore) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={earlierLoading}
                        onClick={() => (task.messageHasMore ? void loadEarlier() : setLimit(Infinity))}
                        className="self-center rounded-full text-xs font-normal text-muted"
                      >
                        {task.messageHasMore ? t('显示更早的消息') : t('显示更早的 {n} 段', { n: hidden })}
                      </Button>
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
                            // 最新的一轮：和 last 分开，子对话列表按它列（父对话自己还在跑时也要列，
                            // 刚发出的用户消息排在后面时也算）
                            latest={i + hidden === latestTurn}
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
                      ) : b.m.peer ? (
                        <div key={b.m.id} className="flex gap-3">
                          <span className="w-[26px] shrink-0" />
                          <div className="min-w-0 flex-1">
                            <ReceivedRow m={b.m} />
                          </div>
                        </div>
                      ) : b.m.role === 'user' ? (
                        <Fragment key={b.m.id}>
                          <UserMessage
                            anchorId={b.m.id}
                            text={b.m.text}
                            at={b.m.at}
                            attachments={b.m.attachments}
                            extra={b.m.delivery && <DeliveryLine delivery={b.m.delivery} />}
                            actions={
                              <>
                                {/* 用户消息常常是一次纠正：项目里的对话随时可以记成项目教训 */}
                                {project && !task.imported && (
                                  <IconButton
                                    size="sm"
                                    icon={GraduationCap}
                                    label={t('记成项目教训')}
                                    title={t('记成项目教训：以后这个项目里的角色都会照着做')}
                                    onClick={() => setLessonOf(b.m.text)}
                                  />
                                )}
                                {/* 对话停着时可以从这条分叉、撤回到这条（第一条不能撤回） */}
                                {task.mode === 'chat' && !running && !task.imported && (
                                  <>
                                    <IconButton
                                      size="sm"
                                      icon={GitFork}
                                      label={t('从这里分叉')}
                                      title={t('从这里分叉：新建一个对话，带着到这条为止的内容')}
                                      onClick={() => fork(b.m.id)}
                                    />
                                    {b.m.id !== firstUser && (
                                      <IconButton
                                        size="sm"
                                        icon={Undo2}
                                        label={t('撤回到这里')}
                                        title={t('撤回到这里：去掉这条和之后的对话，改了再发')}
                                        onClick={() => setRewindAsk(b.m.id)}
                                      />
                                    )}
                                  </>
                                )}
                              </>
                            }
                          />
                          {/* 主理把这条消息分到了哪里：分诊卡，不同意可以一键改派 */}
                          <RouteCard
                            routes={(task.routes ?? []).filter((r) => r.messageId === b.m.id)}
                            later={task.messages.slice(task.messages.indexOf(b.m) + 1)}
                            onReroute={
                              task.imported
                                ? undefined
                                : async (text) => {
                                    try {
                                      apply(await api.sendMessage(task.id, text, [], false))
                                    } catch (e) {
                                      toast.error((e as Error).message)
                                    }
                                  }
                            }
                          />
                        </Fragment>
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
                    {running &&
                      task.mode === 'chat' &&
                      working &&
                      (blocks.at(-1)?.kind === 'turn' ? (
                        <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                          <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                          <RunPhase
                            task={task}
                            label={t('{name} 正在回复', { name: chatLabel })}
                            agentIds={[task.agentId]}
                          />
                          <LiveStats task={task} agentIds={[task.agentId]} />
                        </div>
                      ) : (
                        // 发出消息、还没有输出时就显示是谁在回复、用的哪个模型，不用等第一段输出
                        <PendingReply fallback={byCli ? chatRun : undefined} agentId={task.agentId}>
                          <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                            <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                            <RunPhase task={task} label={t('思考中…')} agentIds={[task.agentId]} />
                            <LiveStats task={task} agentIds={[task.agentId]} />
                          </div>
                        </PendingReply>
                      ))}
                    {/* 这一轮没在跑时先说清在等什么：等后台命令、等派出的子任务、等工作流，最后才是真的停在等下一句。
                      以前只看 awaitingUser 就写「等待你的下一条消息」，子任务还在跑时也这么说
                      （用户报的：子任务在跑、状态行却说在等你 + 空闲）。判定统一用 childWait，不另写一套 */}
                    {running && task.mode === 'chat' && !working && chatWait && (
                      <ChatWaitLine wait={chatWait} awaiting={task.awaitingUser} task={task} />
                    )}
                    {working && task.mode === 'workflow' && runningSteps.length === 0 && (
                      <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                        <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                        <RunPhase task={task} label={t('{name} 正在处理', { name: mainAgent?.name ?? t('主角色') })} />
                        <LiveStats task={task} />
                      </div>
                    )}
                    {/* CLI 还没取走的消息已经直接进对话，这里不用再放一份 */}
                  </ConversationShell>
                </div>
                {/* 中间的子对话页签：同一时间只开一个；切回父对话时不卸载，回来还是原样 */}
                {!pane && openChild && (
                  <section
                    aria-label={t('子对话')}
                    data-child-view
                    className={cn('flex min-h-0 flex-1 flex-col', !showOther && 'hidden')}
                  >
                    <TaskView
                      key={openChild}
                      taskId={openChild}
                      project={project}
                      pane
                      onClose={() => openChildIn('')}
                    />
                  </section>
                )}
                {/* 中间的运行页签：这一次工作流运行的节点和实时输出，底下带着输入框 */}
                {!pane && showOther && openRun > 0 && (
                  <RunPanel
                    task={task}
                    run={openRun}
                    name={task.workflowName || workflow?.name}
                    onClose={() => openRunIn(0)}
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
                    onBack={() => setPaneRun(null)}
                    onClose={onClose}
                    footer={composer}
                  />
                )}
              </main>

              {/* Chat 页的右栏：代码、来源、附件（聊天没有项目文件）。宽屏并排，窄屏不占位置 */}
              {chatRailShown && (
                <aside
                  aria-label={t('聊天右栏')}
                  data-chat-rail
                  className="panel relative hidden w-[min(420px,40%)] shrink-0 flex-col overflow-hidden xl:flex"
                >
                  <ChatRail rail={chatRail} onOpenFile={(path) => setFileTarget({ path, local: true })} />
                </aside>
              )}
              {/* 右栏：项目文件和本对话改动（或 AI 分析的功能面板）。子对话、运行在中间开页签，不占这一栏。
              外面不滚动，拖动条才不会被 overflow 裁掉 */}
              {!pane && (
                <aside
                  ref={setRail}
                  aria-label={!panel && (reportOn || reportCover) && report ? reportTitle(report.kind) : t('文件')}
                  data-task-panel
                  style={{
                    // 功能面板：覆盖态（窄屏从标题栏打开、pane 里）没有并排可拖，按定宽封顶在容器内；
                    // 宽屏并排时用拖过的宽度（记在这台机器上，刷新后保持），没拖过就是和对话对半
                    width:
                      !panel && reportCover
                        ? `min(${REPORT_COVER_WIDTH}px, 100%)`
                        : !panel && reportOn
                          ? reportPane.width
                          : taskPanel.width,
                  }}
                  className={cn(
                    'relative shrink-0 flex-col',
                    embed ? 'border-l bg-rail' : 'panel',
                    panel || reportCover ? 'fixed inset-y-0 right-0 z-40 flex max-w-full shadow-pop' : 'hidden',
                    // 宽屏固定在这一栏上：拖动条 absolute 定位在左边缘，位置不能是 static，否则会跑到外层容器上去
                    'xl:relative xl:z-auto xl:flex xl:h-full xl:shadow-none',
                    (filesFolded || noFiles) && !reportOn && !reportCover && 'xl:hidden',
                  )}
                >
                  {/* 功能面板占右栏（宽屏并排）时也能拖，和文件面板一样记在本机；
                  窄屏和 pane 里是盖在对话上的抽屉（reportCover），没有并排可拖，那时不挂拖动条 */}
                  {!panel && reportOn && !reportCover && (
                    <ResizeHandle pane={reportPane} label={t('拖动调整功能面板的宽度')} className="hidden xl:block" />
                  )}
                  {!panel && !reportOn && !reportCover && (
                    <ResizeHandle pane={taskPanel} label={t('拖动调整文件面板的宽度')} className="hidden xl:block" />
                  )}
                  {panel && (
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
                  {!panel && (reportOn || reportCover) && reportPanel ? (
                    reportPanel
                  ) : (
                    <TaskFiles
                      task={task}
                      dir={project?.path}
                      node={isFlow ? task.steps.find((s) => s.id === flowSel) : undefined}
                      onTask={apply}
                    />
                  )}
                </aside>
              )}
              {(panel || reportCover) && (
                <div
                  className="fixed inset-0 z-30 bg-black/40 xl:hidden"
                  onClick={() => (reportCover ? setReportCover(false) : setPanel(false))}
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
                '正在执行的这一轮会被停下，Agent 进程直接结束（不再留着等下一句）。这一轮已经写出的内容保留，下一句会重新开一个会话。',
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
              description={t(
                '对话记录会移进回收站，{days} 天内可以在设置 →「数据」→ 回收站里恢复；已经改动的文件不会撤销。',
                { days: TRASH_RETENTION_DAYS },
              )}
              onConfirm={remove}
            />
            <FileDialog taskId={task.id} target={fileTarget} onOpenChange={(o) => !o && setFileTarget(null)} />
            <JobDialog taskId={task.id} target={jobTarget} onOpenChange={(o) => !o && setJobTarget(null)} />
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
              subject={task.title}
              start={async (focus) =>
                startAnalysis({
                  tasks: [await api.task(task.id)],
                  agents: localAgents,
                  projectId: task.projectId,
                  focus,
                })
              }
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
    // 和工作流运行卡片同一层浅底（组件库「计划 · 工作流」），不描边、不加阴影
    <div className="overflow-hidden rounded-xl bg-sel/45">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-sel/60"
      >
        <TaskStatusIcon status={status} working={working} />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">
          {rec?.workflowName || task.workflowName || t('工作流')}
        </span>
        <span className="shrink-0 text-xs text-subtle">{t('第 {n} 次运行', { n: run })}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
      </button>
      <div className="flex flex-col pb-1">
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
      <FileInput className="h-4 w-4 shrink-0 text-accent-text" />
      <span className="min-w-0 flex-1 text-[0.8125rem] text-muted">
        {t('这是从文件导入的任务（{at} 导出{app}），只能查看，不能继续执行。', {
          at: (info.exportedAt || info.at).slice(0, 16).replace('T', ' '),
          app: info.app ? t('，面板 {v}', { v: info.app }) : '',
        })}
      </span>
      <Button size="sm" variant="secondary" className="shrink-0 rounded-lg" onClick={onAnalyze}>
        <Sparkles className="h-3.5 w-3.5 text-accent-text" />
        {t('AI 分析')}
      </Button>
    </div>
  )
}

/** 用户消息下面的小按钮（分叉、撤回） */

/** 输入框上面一行的提示条（没走完的流程）：本身有实质内容，保留虚线圆角的框 */
const barRow =
  'flex items-center gap-2 rounded-xl border border-dashed border-line-strong bg-card/60 px-3 py-2 text-[0.8125rem]'

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
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-accent-text hover:bg-accent/10 disabled:opacity-50"
        >
          {resuming ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
          {t('继续流程')}
        </button>
        <IconButton icon={X} label={t('结束流程')} title={t('结束流程，不再继续')} onClick={() => setAsking(true)} />
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
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
      ) : item ? (
        <WorktreeMark item={item} />
      ) : (
        <GitBranch className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-accent-text' : 'text-subtle')} />
      )}
      <span className="flex min-w-0 items-center gap-1 font-mono text-[0.75rem]">
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
  latest,
  fallback,
  command,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live: boolean
  last: boolean
  /** 对话里的最新一轮（和父对话在不在跑无关）：运行区的子对话、后台命令按它列 */
  latest: boolean
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
      latest={latest}
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
 * 这一轮没在跑时状态行：先说清在等什么结果，真的停在等下一句时才说「等待你的下一条消息」。
 * 等用户回答、等确认由对话里的提问卡片表达，这里不重复
 */
function ChatWaitLine({ wait, awaiting, task }: { wait: ChildWait; awaiting: boolean; task: Task }) {
  if (wait.kind === 'answer' || wait.kind === 'confirm') return null
  // 等下一句要 CLI 真的停在面板工具上等（awaitingUser）：只是预热完、还在启动时不写成在等你
  if (wait.kind === 'next' && !awaiting) return null
  // 文案都用已有的：子任务和工作流这两句和 RunPhase 同源，没有新词
  const text =
    wait.kind === 'helpers'
      ? t('等待 {n} 个子任务完成', { n: wait.list.length })
      : wait.kind === 'background'
        ? t('等 {n} 个后台命令', { n: wait.n })
        : wait.kind === 'workflow'
          ? t('等工作流跑完')
          : t('等待你的下一条消息')
  const next = wait.kind === 'next'
  return (
    <div className="flex items-center gap-2 text-[0.8125rem] text-muted" data-chat-wait={wait.kind}>
      {/* 还在等别人的结果：转圈；等你的下一句：对话气泡 + 动态点 */}
      {next ? (
        <MessageSquareText className="h-4 w-4 text-subtle" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
      )}
      <span className="inline-flex items-baseline">
        {text}
        {next && <WaitDots />}
      </span>
      {/* 等下一句时确实空闲（它在等你），等别人的结果时才是「等待中」：不把在干活的对话说成没事做 */}
      <LiveStats task={task} agentIds={[task.agentId]} waiting={!next} />
    </div>
  )
}

/**
 * 执行中的状态文字：最近一段时间没有任何输出、也没有工具在跑，说明在等模型的下一段。
 * 模型请求本身要几秒到几十秒（上下文越大越久），标出来，免得看起来像卡在工具上
 *
 * agentIds 要和同一行 LiveStats 的传法一致：判断「真的在出 token」只能看这一行显示的那几个 Agent，
 * 看全部 Agent 会把「别人在输出、这一轮自己在排队」当成在输出，反而把真排队遮掉
 */
function RunPhase({ task, label, agentIds }: { task: Task; label: string; agentIds?: string[] }) {
  const now = useNow(true)
  const idle = now - Date.parse(task.updatedAt)
  // 执行中发的补充排在最后：还在跑的命令在它前面那条回复里，不能只看最后一条
  const busy =
    !!task.requests.length ||
    task.messages.slice(-4).some((m) => m.tools.some((x) => x.running || (x.ms === undefined && !!x.startedAt)))
  // 对话派出的子任务还没做完：对话停在这里等它们，结果交回后接着回复
  const helpers = task.steps.filter((s) => helperRunning(s) && s.parentId === '@chat')
  // 这一行确实在出 token（同一行右边显示着速度）：就不是「还没开始」，不能标成在排队
  const streaming = tpsNow(task, agentIds?.every(Boolean) ? agentIds : undefined) > 0
  // API 设置的并发上限满了：这一轮排着队，前面的对话或子任务释放了才开始（输入框照样是停止按钮）。
  // 只看「开跑前就排着」的标记：让出名额后拿回的（等子任务、等下一句）这一轮已经跑起来了，
  // 它排的是「交回结果的那一句」而不是「这一轮」，写成排队会和右边的实时速度自相矛盾
  const wait = apiQueueWait(task, streaming)
  if (wait)
    return (
      <>
        {wait.ahead
          ? t('排队等 API「{api}」空出并发名额 · 前面还有 {n} 个', { api: wait.api, n: wait.ahead })
          : t('排队等 API「{api}」空出并发名额 · 下一个就是这里', { api: wait.api })}
      </>
    )
  if (helpers.length && !busy) return <>{t('等待 {n} 个子任务完成', { n: helpers.length })}</>
  // 等模型也是一种耗时：和别处同一套写法（已 41.2s / 已 2m 5s）
  return <>{busy || streaming || idle < 1500 ? label : t('等待模型 · 已 {wait}', { wait: fmtDuration(idle) })}</>
}
