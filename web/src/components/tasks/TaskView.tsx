import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { toast } from 'sonner'
import {
  ChevronRight,
  FlaskConical,
  GitBranch,
  GitFork,
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
  Check,
  Workflow as WorkflowIcon,
  Download,
  FileInput,
  Sparkles,
} from 'lucide-react'
import { DEFAULT_AGENT_ID, type Project, type Task, type TaskMessage, type TaskStep } from '@shared/schema'
import { ChatModelPicker, useChatRun, useRunAuthor, type ChatRun } from './ChatModelPicker'
import { blockedStep, flowUnfinished, MAIN_STEP, rootStepId, taskFlow, taskWorkflows, topSteps } from '@shared/flow'
import { chatName, taskSummary, withTaskModel } from '@shared/task'
import { agentRun, defaultCli, defaultSettings } from '@shared/settings'
import { getCli, steerable } from '@shared/clis'
import { api } from '@/lib/api'
import { useTaskStream } from '@/lib/task-stream'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { WithAgents, useData, useNav } from '@/lib/data'
import { downloadTask } from '@/lib/task-transfer'
import { withImportedAgents } from '@shared/task-export'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { AgentMessage, ChatReply, NoteMessage, PendingAuthor } from './Messages'
import { useAgentView } from '@/lib/agent-view'
import { LiveStats } from './LiveStats'
import { NextWorkflows } from './NextWorkflows'
import { AnalyzeDialog, EvolutionCard } from './Evolution'
import { StepSection } from './StepSection'
import { RunCard, RunDrawer } from './RunCard'
import { TaskPanel } from './TaskPanel'
import { TaskMeta } from './TaskMeta'
import { TaskFiles } from './TaskFiles'
import { FileDialog, FileOpenCtx } from './FileDialog'
import { TaskRequestCard, asksQuestion } from './RequestCard'
import { useSlashMenu } from '@/components/chat/SlashMenu'
import { AskToggle } from '@/components/chat/AskToggle'
import { ParamsChip } from '@/components/agents/ParamFields'
import { TaskStatusIcon } from './TaskStatusIcon'
import { ATTACHMENT_PROMPT, useAttachments, useFileMention } from '@/components/chat/Attachments'
import { ChatComposer, useDraft } from '@/components/chat/ChatComposer'
import type { RichInputHandle } from '@/components/chat/RichInput'
import { forSend } from '@shared/composer'
import { UserMessage, msgAction } from '@/components/chat/ChatMessage'

/** 流程图视图用到的画布库比较大，切到流程图时才加载 */
const TaskFlow = lazy(() => import('./TaskFlow').then((m) => ({ default: m.TaskFlow })))

type Block =
  | { kind: 'msg'; m: TaskMessage }
  /** 对话里 Agent 连续的回复（一轮），完成后折叠过程 */
  | { kind: 'turn'; key: string; msgs: TaskMessage[] }
  | { kind: 'steps'; key: string; roots: string[]; byRoot: Map<string, TaskMessage[]> }
  /** 工作流的一次运行：节点输出去右边的面板里看 */
  | { kind: 'run'; key: string; run: number }

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
  // 工作流任务：一次运行一张卡片，没有单独的节点段。主 Agent 的消息插在节点输出之间，
  // 所以按「第一次出现这次运行」的位置放卡片，后面的节点消息都跳过
  const byRun = task.mode === 'workflow'
  const carded = new Set<number>()
  // 往后找第一条带节点的消息：判断这条用户消息后面还有没有同一个节点的输出
  const nextRoot = (from: number) => {
    for (let i = from; i < msgs.length; i++) if (msgs[i].step) return rootStepId(msgs[i].step)
    return undefined
  }
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
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
/** 右栏拖宽时中间至少留这么宽：比「内容宽度」小，窄一些的窗口里也能把右栏拖宽一点 */
const MIN_CHAT = 480

export function TaskView({
  taskId,
  project,
  embed,
}: {
  taskId: string
  project?: Project
  /** 放在弹窗里（例如「AI 处理」）：标题栏右边加上弹窗自己的按钮；要跳到别的页面时先收起弹窗 */
  embed?: { actions: React.ReactNode; onLeave: () => void }
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
  // 没发出去的内容按对话分开记，切到别的对话再回来还在
  const [text, setText] = useDraft(`task:${taskId}`)
  const followTa = useRef<RichInputHandle>(null)
  // 和新建任务的输入框一样：可以附文件、粘贴截图、拖进来、输入 @ 引用项目文件
  const files = useAttachments(`task:${taskId}`)
  const mention = useFileMention(project?.id, followTa)
  const [sending, setSending] = useState(false)
  const [panel, setPanel] = useState(false)
  // 宽屏右栏收起：让对话用满整个宽度，收起的按钮还在标题栏
  const [filesFolded, setFilesFolded] = useState(false)
  // 左边空白不够放任务进度时（窄屏），从标题栏打开，浮在对话上面
  const [progressOpen, setProgressOpen] = useState(false)
  // 右栏可以拖宽，但中间至少留出能读对话的宽度；上限按这一行的实际宽度算
  const taskPanel = usePaneWidth('task-panel', 340, 280, () => {
    const row = document.querySelector('[data-task-panel]')?.parentElement?.clientWidth ?? window.innerWidth
    // 保留中间的内容宽度和一点边距；窗口窄到放不下时上限就是默认宽度，不会反而变窄
    return Math.max(340, Math.min(560, row - MIN_CHAT - 48))
  })
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  // 往上翻得比较远时显示「回到底部」
  const [away, setAway] = useState(false)
  const [limit, setLimit] = useState(BLOCK_LIMIT)
  useEffect(() => setLimit(BLOCK_LIMIT), [taskId])
  useEscape(panel, () => setPanel(false))
  useEscape(progressOpen, () => setProgressOpen(false))
  // Esc 停止正在执行的任务（先确认，免得误触）；右栏开着时 Esc 先关右栏
  const [stopAsk, setStopAsk] = useState(false)
  // Agent 输出里点了文件路径：在弹窗里看文件内容
  const [fileTarget, setFileTarget] = useState<{ path: string; line?: number } | null>(null)
  const openFile = useCallback((path: string, line?: number) => setFileTarget({ path, line }), [])
  useEscape(!!task?.working && !panel && !stopAsk, () => setStopAsk(true))
  const [view, setView] = useState<'chat' | 'flow'>('chat')
  // 流程图里选中的节点，右栏只看它
  const [flowSel, setFlowSel] = useState('')
  // 对话里点开的运行卡片：右边看这一次运行的实时输出
  const [openRun, setOpenRun] = useState(0)
  // 右栏「任务进度」里点了哪一步：切到流程视图并选中它，和点流程图的节点一样
  const [focus, setFocus] = useState<{ id: string; at: number }>()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // 这次打开对话有没有试过后台预热：每个任务只试一次，任务后续变化不用再发
  const prewarmed = useRef('')
  const [rewindAsk, setRewindAsk] = useState('')

  const apply = (next: Task) => {
    setTask(next)
    // 全局列表只放摘要，侧栏不用跟着每段输出重新渲染消息
    upsertTask(taskSummary(next))
  }

  useEffect(() => {
    api
      .task(taskId)
      .then(apply)
      .catch((e) => toast.error((e as Error).message))
    // 换任务时取一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

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

  // 打开旧对话时在后台用 --resume 启动，第一次发消息不用再等 CLI 启动和会话加载
  useEffect(() => {
    if (!task || task.id !== taskId || prewarmed.current === taskId) return
    prewarmed.current = taskId
    if (task.mode !== 'chat' || task.status === 'running' || task.imported || !task.sessions[task.agentId]) return
    api
      .prewarmTask(taskId)
      .then(apply)
      .catch(() => {})
    // 只在这次打开、任务加载出来时试一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task, taskId])

  const running = task?.status === 'running'
  // CLI 真的在处理这一轮才算执行中；预热、等下一句时页面按空闲显示
  const working = task?.working ?? false
  useTaskStream(taskId, running, apply)
  // 还在排队、CLI 没取走的补充：放在对话最下面，取走后才成为正常消息
  const pending = running && task ? task.queue.filter((q) => q.note) : []

  // 停留在底部时自动跟随新输出
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && view === 'chat') el.scrollTop = el.scrollHeight
  }, [task, view])

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
      : task && slashAgent
        ? agentRun(withTaskModel(slashAgent, task), settings ?? defaultSettings()).cli
        : ''
  const slash = useSlashMenu({
    cli: slashCli,
    projectId: project?.id,
    // 压缩、审查是对话的操作，工作流里不提供
    scope: task?.mode === 'workflow' ? 'new' : 'task',
    setText,
    editor: followTa,
    onAction: (a, arg) => {
      if (!task) return
      if (running) return void toast.error(t('任务正在执行，请等它完成或先停止'))
      stick.current = true
      ;(a === 'compact' ? api.compactTask(task.id) : api.reviewTask(task.id, arg))
        .then(apply)
        .catch((e) => toast.error((e as Error).message))
    },
  })

  if (!task)
    return (
      <main className="flex flex-1 items-center justify-center text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </main>
    )

  // 执行中也能发：补充（相关的调整方向，无关的等这一轮完成后再处理；能补充时默认）、排队（这一轮完成后处理）
  const send = async (how: 'steer' | 'queue' = canSteer ? 'steer' : 'queue') => {
    if ((!text.trim() && !files.attachments.length) || sending || files.uploading) return
    const content = forSend(text, files.attachments.length ? ATTACHMENT_PROMPT : '')
    if (!files.items.length && slash.intercept(content)) return
    setSending(true)
    stick.current = true
    try {
      const r = await api.sendMessage(task.id, content, files.attachments, false, working && how === 'steer')
      apply(r)
      setText('')
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
  const resume = async (latest = false) => {
    setResuming(true)
    stick.current = true
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
  // 对话实际用的 CLI：Codex、Claude Code 能在执行中插话，Command Code 这类靠面板的工具取
  const chatCli = chatAgent ? agentRun(withTaskModel(chatAgent, task), settings ?? defaultSettings()).cli : ''
  const chatDef = getCli(chatCli)
  // 工作流的节点收不了补充时，服务端会留给下一个节点，所以工作流总能补充
  const canSteer = working && (task.mode === 'workflow' || steerable(chatCli))
  // 没有插话协议、靠面板的工具取补充的 CLI：发出去先排进队列，它执行中会自己取走
  const byNotes = task.mode === 'chat' && !!chatDef?.notes && !chatDef.steer
  // 用默认 Agent 的对话按 CLI 显示：署名是 CLI、模型和思考强度，输入框里随时能换，下一轮生效
  const byCli = task.mode === 'chat' && task.agentId === DEFAULT_AGENT_ID
  const chatRun = { cli: task.cli, model: task.model, effort: task.effort }
  const chatLabel = (byCli ? getCli(chatCli)?.name : chatName(chatAgent, task)) || 'Agent'
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
  const blocks = toBlocks(task)
  // 很长的任务先只画最后一部分，打开、刷新更快；往前看时再全部显示
  const hidden = Math.max(0, blocks.length - limit)
  const isFlow = task.mode === 'workflow' && view === 'flow'
  // 点了任务进度里的某一步：切到流程图并定位到那一步
  const openStep =
    task.mode === 'workflow'
      ? (id: string) => {
          setPanel(false)
          // 流程视图里和点流程图的节点一样，选中它；对话视图里滚到这一步的输出，不切换视图
          if (view === 'flow') return setFocus({ id, at: Date.now() })
          const el = scroller.current
          const sec = el?.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"]`)
          // 这一步在还没显示的较早内容里：先全部显示，画出来后再滚过去
          if (!sec && hidden) {
            setLimit(Infinity)
            return requestAnimationFrame(() => requestAnimationFrame(() => openStep?.(id)))
          }
          if (!el || !sec) return toast(t('这一步还没有输出'))
          stick.current = false
          el.scrollTo({
            top: sec.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8,
            behavior: 'smooth',
          })
        }
      : undefined
  const toBottom = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    setAway(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
  // 工作流没走完时输入框上面有「继续流程」，输入框里就不再放「继续执行」
  const flowLeft = task.mode === 'workflow' && !running && flowUnfinished(task, workflow)
  const blocked = task.mode === 'workflow' ? blockedStep(task, taskFlow(task, workflow)) : undefined
  const canResume = (task.status === 'failed' || task.status === 'stopped') && !text.trim() && !flowLeft

  const exportIt = () => downloadTask(task.id, agents).catch((e) => toast.error((e as Error).message))

  // 右边看某一次运行的实时输出时，输入框跟着挪到那个面板底下，不用关掉再看对话
  const composer = !task.imported && !asksQuestion(task.requests) && (
    <ChatComposer
      id="follow-up"
      value={text}
      onChange={setText}
      onSubmit={() => void send()}
      files={files}
      taRef={followTa}
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
      canSend={!!text.trim() || files.attachments.length > 0}
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
          {task.mode === 'chat' && !byCli && chatAgent && chatAgent.params.length > 0 && (
            <ParamsChip
              params={chatAgent.params}
              values={task.params}
              onChange={(v) => {
                setTask({ ...task, params: v })
                api.setTaskParams(task.id, v).then(apply, (e) => toast.error((e as Error).message))
              }}
            />
          )}
          {byCli ? (
            <ChatModelPicker value={chatRun} onChange={changeRun} />
          ) : (
            <span className="min-w-0 truncate pl-1 text-xs text-subtle">
              {working
                ? tops.filter((s) => s.status === 'running').length > 1
                  ? t('{n} 个节点同时执行中', { n: tops.filter((s) => s.status === 'running').length })
                  : t('执行中，可以随时暂停')
                : task.mode === 'workflow'
                  ? blocked
                    ? t('主 Agent 处理后会接着走流程')
                    : roots.every((s) => s.status === 'done')
                      ? t('由主 Agent {name} 处理追加要求', { name: mainAgent?.name ?? '' })
                      : task.status === 'failed'
                        ? t('会从失败的节点重新执行')
                        : t('会从没完成的节点继续执行')
                  : t('发给 {name}', { name: chatLabel })}
            </span>
          )}
        </>
      }
      running={working}
      onStop={stop}
      onQueue={() => void send('queue')}
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
            ? byNotes
              ? t('执行中也可以输入：Agent 执行时会取走，相关的调整方向，无关的等这一轮结束后处理')
              : t('执行中也可以输入：相关的会调整当前方向，无关的等这一轮完成后再处理')
            : t('执行中也可以输入，这一轮完成后接着处理')
      }
    />
  )

  return (
    <WithAgents agents={agents}>
      <FileOpenCtx.Provider value={openFile}>
        <div className="relative flex min-h-[70vh] min-w-0 flex-1 md:h-full md:min-h-0">
          <main className="flex min-w-0 flex-1 flex-col md:h-full">
            <header
              className={cn(
                'flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-colors md:px-5',
                scrolled ? 'border-line' : 'border-transparent',
              )}
            >
              <nav aria-label={t('位置')} className="flex min-w-0 flex-1 items-center gap-1 text-[0.84375rem]">
                <button
                  onClick={() => go(project ? { page: 'projects', id: project.id } : { page: 'chat' })}
                  className="hidden max-w-[30%] shrink-0 cursor-pointer truncate rounded-md px-1.5 py-1 text-muted hover:bg-sel hover:text-fg sm:block"
                >
                  {project?.name ?? t('聊天')}
                </button>
                <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-subtle sm:block" />
                <TaskStatusIcon status={task.status} working={task.working} className="ml-1" />
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
                {task.simulated && (
                  <span
                    title={t('没有真正调用 CLI，输出是示例')}
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
                        stick.current = v === 'chat'
                        if (v === 'flow' && scroller.current) scroller.current.scrollTop = 0
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
              {/* 宽屏右栏一直占着位置，这个按钮把文件面板收起来，让对话用满整个宽度 */}
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
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t('更多操作')}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setRenaming(task.title)}>
                    <Pencil className="h-4 w-4" />
                    {t('重命名')}
                  </MenuItem>
                  <MenuItem onSelect={exportIt}>
                    <Download className="h-4 w-4" />
                    {t('导出任务')}
                  </MenuItem>
                  <MenuItem disabled={running} onSelect={() => setAnalyzing(true)}>
                    <Sparkles className="h-4 w-4" />
                    {t('AI 分析执行结果')}
                  </MenuItem>
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
              {embed?.actions}
            </header>

            <div className="relative flex min-h-0 flex-1 flex-col">
              {progressOpen && (
                <div className="absolute top-3 left-3 z-20 w-[min(340px,calc(100%-1.5rem))] md:left-4">
                  <TaskPanel task={task} onStep={openStep} className="shadow-pop" />
                </div>
              )}
              <div
                ref={scroller}
                onScroll={(e) => {
                  const el = e.currentTarget
                  stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                  setScrolled(el.scrollTop > 4)
                  setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 240)
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
                        stick.current = true
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
                    {blocks.slice(hidden).map((b, i) =>
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
                        <RunCard
                          key={b.key}
                          task={task}
                          run={b.run}
                          name={task.workflowName || workflow?.name}
                          onOpen={() => setOpenRun(b.run)}
                        />
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
                            // 对话停着时可以从这条分叉、撤回到这条（第一条不能撤回）
                            task.mode === 'chat' &&
                            !running &&
                            !task.imported && (
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
                            )
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
                    <EvolutionCard task={task} />
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
                          label={t('{name} 正在处理', { name: mainAgent?.name ?? t('主 Agent') })}
                        />
                        <LiveStats task={task} />
                      </div>
                    )}
                    {/* CLI 还没取走的消息先放在最下面，取走后才插到回复里 */}
                    {pending.map((q) => (
                      <UserMessage
                        key={q.id}
                        text={q.text}
                        at={q.at}
                        attachments={q.attachments}
                        pending
                        actions={
                          <button
                            type="button"
                            className={msgAction}
                            title={t('撤回这条要求')}
                            aria-label={t('撤回')}
                            onClick={() =>
                              api
                                .unqueue(task.id, q.id)
                                .then(apply)
                                .catch((e) => toast.error((e as Error).message))
                            }
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        }
                      />
                    ))}
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

            <div className="px-3 pt-1 pb-3 md:px-6 md:pb-5">
              <TaskRequestCard task={task} onAnswered={apply} />
              <WorktreeBar task={task} onChange={apply} />
              {flowLeft && !task.imported && (
                <FlowBar task={task} blocked={blocked} resuming={resuming} onResume={() => resume()} onChange={apply} />
              )}
              <QueuedList task={task} onChange={apply} />
              {task.imported && <ImportedBar task={task} onAnalyze={() => setAnalyzing(true)} />}
              {/* 点开运行面板时输入框挪进面板，这里先空着，避免出现两个输入框 */}
              {!openRun && composer}
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
          </main>

          {/* 右栏是文件系统：外面不滚动，拖动条才不会被 overflow 裁掉；文件树自己滚 */}
          <aside
            aria-label={t('文件')}
            data-task-panel
            style={{ width: taskPanel.width }}
            className={cn(
              'shrink-0 flex-col border-l bg-rail',
              panel ? 'fixed inset-y-0 right-0 z-40 flex max-w-full shadow-pop' : 'hidden',
              // 宽屏固定在这一栏上：拖动条 absolute 定位在左边缘，位置不能是 static，否则会跑到外层容器上去
              'xl:relative xl:z-auto xl:flex xl:h-full xl:shadow-none',
              filesFolded && 'xl:hidden',
            )}
          >
            {!panel && (
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
            <TaskFiles
              task={task}
              dir={project?.path}
              node={isFlow ? task.steps.find((s) => s.id === flowSel) : undefined}
              onTask={apply}
            />
          </aside>
          {panel && <div className="fixed inset-0 z-30 bg-black/40 xl:hidden" onClick={() => setPanel(false)} />}
        </div>
        <ConfirmDialog
          open={stopAsk && working}
          onOpenChange={setStopAsk}
          title={t('停止这个任务？')}
          description={t('正在执行的 CLI 会被停下，之后可以点「继续执行」从中断的地方接着做。')}
          confirmText={t('停止')}
          onConfirm={async () => {
            await stop()
            setStopAsk(false)
          }}
        />
        <ConfirmDialog
          open={!!rewindAsk}
          onOpenChange={(o) => !o && setRewindAsk('')}
          title={t('撤回到这条消息？')}
          description={t(
            '这条消息和之后的对话会去掉，内容放回输入框，改了可以再发。CLI 会从这条之前接着聊；已经改动的文件不会撤销，需要的话在「更改」里撤销。',
          )}
          confirmText={t('撤回')}
          onConfirm={async () => {
            try {
              const r = await api.rewindTask(task.id, rewindAsk)
              apply(r.task)
              setText(r.text)
              setRewindAsk('')
              followTa.current?.focus()
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        />
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t('删除任务「{title}」？', { title: task.title })}
          description={t('会删除这个任务的对话记录，不会撤销已经改动的文件。')}
          onConfirm={remove}
        />
        <FileDialog taskId={task.id} target={fileTarget} onOpenChange={(o) => !o && setFileTarget(null)} />
        {openRun > 0 && (
          <RunDrawer
            task={task}
            run={openRun}
            name={task.workflowName || workflow?.name}
            onClose={() => setOpenRun(0)}
            footer={composer}
          />
        )}
        <AnalyzeDialog
          open={analyzing}
          onOpenChange={setAnalyzing}
          tasks={async () => [await api.task(task.id)]}
          projectId={task.projectId}
        />
      </FileOpenCtx.Provider>
    </WithAgents>
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

/** 输入框上面一行的提示条（排队的要求、没走完的流程）共用的样式 */
const barRow =
  'flex items-center gap-2 rounded-xl border border-dashed border-line-strong bg-card/60 px-3 py-2 text-[0.8125rem]'
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
        : t('流程没有完成，主 Agent 还没整理结果')
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
        description={t('没完成的节点不再执行，已经做完的改动保留。之后输入的要求由主 Agent 直接处理。')}
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

/** 执行中排队的要求：这一轮完成后按顺序处理，处理前可以修改、撤回 */
function QueuedList({ task, onChange }: { task: Task; onChange: (t: Task) => void }) {
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  // 执行中、CLI 还没取走的补充已经作为气泡放在对话最下面了，这里只列真正排队等下一轮的
  const items = task.status === 'running' ? task.queue.filter((q) => !q.note) : task.queue
  if (!items.length) return null
  const paused = task.status !== 'running'
  const save = (qid: string) => {
    const text = draft.trim()
    const q = task.queue.find((x) => x.id === qid)
    setEditing('')
    if (!text || text === q?.text) return
    api
      .editQueued(task.id, qid, text)
      .then(onChange)
      .catch((e) => toast.error((e as Error).message))
  }
  return (
    <ul className="mx-auto mb-2 flex max-w-(--content-w) flex-col gap-1.5">
      {items.map((q, i) => (
        <li key={q.id} className={barRow}>
          <ListPlus className="h-3.5 w-3.5 shrink-0 text-subtle" />
          {editing === q.id ? (
            <>
              <input
                autoFocus
                aria-label={t('修改排队的要求')}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    save(q.id)
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEditing('')
                  }
                }}
                className="h-6 min-w-0 flex-1 rounded-md border border-accent bg-field px-2 outline-none"
              />
              <button
                type="button"
                aria-label={t('保存')}
                title={t('保存（Enter）')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => save(q.id)}
                className={barIcon}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate" title={q.text}>
                {q.text}
              </span>
              <span className="shrink-0 text-xs text-subtle">
                {paused
                  ? t('排队中 · 任务没在执行，点「继续执行」后处理')
                  : q.note
                    ? t('Agent 执行中会取走')
                    : i === 0
                      ? t('下一条')
                      : t('排队中')}
              </span>
              <button
                type="button"
                aria-label={t('修改')}
                title={t('修改这条要求')}
                onClick={() => {
                  setDraft(q.text)
                  setEditing(q.id)
                }}
                className={barIcon}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            aria-label={t('撤回')}
            title={t('撤回这条要求')}
            onClick={() =>
              api
                .unqueue(task.id, q.id)
                .then(onChange)
                .catch((e) => toast.error((e as Error).message))
            }
            className={barIcon}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 独立分支执行的任务：停下后可以把改动合并进项目，或者整个丢弃 */
function WorktreeBar({ task, onChange }: { task: Task; onChange: (t: Task) => void }) {
  const [asking, setAsking] = useState<'merge' | 'discard' | null>(null)
  const wt = task.worktree
  if (!wt) return null
  const running = task.status === 'running'
  const target = wt.baseBranch || t('项目当前的分支')
  const finish = (merge: boolean) =>
    api
      .finishWorktree(task.id, merge)
      .then((x) => {
        onChange(x)
        setAsking(null)
        toast.success(merge ? t('已合并到「{branch}」', { branch: x.worktree?.note || target }) : t('已丢弃独立分支'))
      })
      .catch((e) => {
        setAsking(null)
        toast.error((e as Error).message)
      })
  return (
    <div className="mx-auto mb-2 flex max-w-(--content-w) flex-wrap items-center gap-2 rounded-xl border border-line bg-card/60 px-3 py-2 text-[0.8125rem]">
      <GitBranch className={cn('h-3.5 w-3.5 shrink-0', wt.state === 'active' ? 'text-accent' : 'text-subtle')} />
      <span className="min-w-0 flex-1 text-muted">
        {wt.state === 'merged'
          ? t('独立分支已合并到「{branch}」', { branch: wt.note || target })
          : wt.state === 'discarded'
            ? t('独立分支已丢弃，项目目录没有改动')
            : running
              ? t('在独立分支 {name} 上执行，不改动项目目录', { name: wt.branch })
              : t('改动在独立分支 {name} 上，还没进项目目录', { name: wt.branch })}
      </span>
      {wt.state === 'active' && !running && (
        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setAsking('discard')}>
            {t('丢弃')}
          </Button>
          <Button size="sm" onClick={() => setAsking('merge')}>
            {t('合并到「{branch}」', { branch: target })}
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={!!asking}
        onOpenChange={(o) => !o && setAsking(null)}
        title={asking === 'merge' ? t('把改动合并到「{branch}」？', { branch: target }) : t('丢弃独立分支？')}
        description={
          asking === 'merge'
            ? t('没提交的改动会先提交到任务分支，再合并进项目目录当前的分支。有冲突时不会改动项目目录。')
            : t('会删除任务分支和它的工作目录，里面的改动都会丢掉，项目目录不受影响。')
        }
        confirmText={asking === 'merge' ? t('合并') : t('丢弃')}
        onConfirm={() => finish(asking === 'merge')}
      />
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
  const busy = !!task.requests.length || (task.messages.at(-1)?.tools ?? []).some((x) => x.running)
  return <>{busy || idle < 1500 ? label : t('等待模型 · 已 {n} 秒', { n: Math.floor(idle / 1000) })}</>
}
