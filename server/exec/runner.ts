import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  aliasAgent,
  defaultAgent,
  type Agent,
  type AgentUsage,
  type Attachment,
  type CliStatus,
  type Project,
  type Settings,
  type StopReason,
  type Task,
  type TaskMessage,
  type TaskStep,
  type ToolUse,
  type Alert,
  type Workflow,
} from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { classifyError, isGatewayError, makeAlert } from '../../shared/alerts.ts'
import {
  addNoteTaker,
  hasHeld,
  holdForNextTurn,
  noteTakersOf,
  removeNoteTaker,
  takeHeld,
  type NoteTaker,
} from './delivery.ts'
import { clearApiWait, markApiWait } from './api-wait.ts'
import { agentPermission, agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import {
  changesSince,
  mergeChanges,
  ownedChanges,
  pauseRun,
  questionAnswers,
  resumeRun,
  sessionChanged,
  sessionMoved,
  stepUsage,
  withAttachments,
  withTaskModel,
} from '../../shared/task.ts'
import { activePlan, inputUnhandled, planNotice } from '../../shared/plan.ts'
import { effectiveTimeoutMinutes } from '../../shared/schedule.ts'
import { attachmentAddDirs, placedFiles } from '../attachments.ts'
import { UPLOADS_DIR } from '../uploads.ts'
import { CACHE_DIR, HANDOFF_DIR } from '../store.ts'
import { expandSlash } from '../slash.ts'
import { cachedModels, knownWindows, markNoEffort, supportedEffort } from '../models.ts'
import { autoLimits, limitEnvVars, type ModelLimits } from '../../shared/model-limits.ts'
import { apiModelInfo, apiModelKey } from '../../shared/model-catalog.ts'
import { mergedModelCatalog } from '../model-catalog-store.ts'
import {
  NODE_PART,
  helperGate,
  runEngineTurn,
  type AgentCall,
  type AgentResult,
  type EngineHost,
} from '../../shared/engine.ts'
import { projectFormat } from '../../shared/file-format.ts'
import { searchExcludeOf, searchExcludeRgConfig } from '../../shared/search-exclude.ts'
import { clip } from '../../shared/text.ts'
import { composeRole, defaultChatPrompt, includedAgents, nodeAgentRun } from '../../shared/agent-role.ts'
import { fillSkills } from '../../shared/expose.ts'
import { listIntegrations } from '../integrations.ts'
import { ensureBundled } from '../bundled-skills.ts'
import { gitChanges, reviewDiff } from './git.ts'
import { invokeCli, type CliControl } from './invoke.ts'
import { setLimits } from '../cli-extras.ts'
import type { BuildOptions } from '../../shared/clis.ts'
import type { AskReply, CliEvent } from './parsers.ts'
import { childEnv } from './process.ts'
import { REQUEST_TIMEOUT_MS } from './rpc/session.ts'
import { redirectWait } from './redirect.ts'
import { t, getLang } from '../../shared/i18n.ts'
import { fmtDuration } from '../../shared/duration.ts'
import { promptLangReminder, promptLangRules } from '../../shared/prompt-lang.ts'
import { compactedSilently } from '../../shared/prompt-delta.ts'
import { PROMPT_LANG_ENV, ensurePromptLangMod } from './prompt-lang-mod.ts'
import { log } from '../log.ts'
import { AUTO_ANSWER } from '../asks.ts'
import { orchHint } from '../orch-mcp.ts'
import { openBlenderSession } from '../blender-mcp.ts'
import { MODEL_HINT } from '../../shared/blender.ts'
import { lessonsPrompt } from '../../shared/lessons.ts'
import { readGlobalLessons } from '../lessons.ts'
import { hasViewer, isWatched, seenWhileWatched } from '../presence.ts'
import { ApiSlot } from '../api-slots.ts'

/** 这一轮完成：页面正开着就算已经看过，没开着才留橙点等用户回来看 */
function markTurnDone(task: Task) {
  const now = new Date().toISOString()
  task.turnDoneAt = now
  if (seenWhileWatched(task.id)) task.turnSeenAt = now
}

export interface RealContext {
  task: Task
  agents: Agent[]
  workflows: Workflow[]
  workflow?: Workflow
  project: Project
  settings: Settings
  clis: CliStatus[]
  /** 本轮用户输入 */
  prompt: string
  signal: AbortSignal
  /** 为什么停下这一轮：'user' 是用户按的暂停，其余是顺带结束的动作（见 EngineHost.stopReason） */
  stopReason?: () => StopReason | undefined
  /**
   * 开始保活（CLI 回复完停在等下一句）时通知宿主：宿主按全局上限收掉最久没用的保活会话，
   * 不然页面开着过、又切走的对话会各留一个进程，叠起来就是十几个
   */
  onKeepAlive?: (taskId: string) => void
  /**
   * 对话这一轮真的结束了（CLI 报了这一轮的结果，或者回复完停在等下一句）。
   * 子对话靠它收口父对话计划里等自己的步骤：进程会被保活留着等下一句，run 不会返回，收尾处的回报等不到。
   * tools：这一轮调用过几次工具（顶层对话据此分辨「做到一半停了」和「只是回答了一句话」）
   */
  onTurnEnd?: (turn: { tools: number }) => void
  changed: (flush?: boolean) => void
  newId: () => string
  /** 任务所在目录是否是 git 仓库（决定改动从 git 读还是从工具调用里统计） */
  isGit: boolean
  /** 这一轮不是普通的对话：压缩上下文，或者审查代码 */
  op?: AgentCall['op']
  /** 「继续流程」：见 EngineHost.resume */
  resume?: boolean
  /** 打开对话页时后台用 --resume 启动，只等下一句 */
  prewarm?: boolean
  prewarmFrom?: Task['status']
  prewarmTurnDoneAt?: string
  /** 对话 Agent 启动计划、分派子对话用的项目数据（见 EngineHost） */
  workflowCatalog?: EngineHost['workflowCatalog']
  resolveWorkflow?: EngineHost['resolveWorkflow']
  listConversations?: EngineHost['listConversations']
  createConversation?: EngineHost['createConversation']
  sendToConversation?: EngineHost['sendToConversation']
  /** 父子对话之间的通讯和文件认领（见 EngineHost） */
  rules?: EngineHost['rules']
  goal?: EngineHost['goal']
  takeInbox?: EngineHost['takeInbox']
  messageParent?: EngineHost['messageParent']
  claimFiles?: EngineHost['claimFiles']
  releaseFiles?: EngineHost['releaseFiles']
  /** 子对话点名「禁止子对话执行」的角色时转交父对话（见 ADR 0019） */
  forwardSpawn?: EngineHost['forwardSpawn']
  /** 对话级的 Orchestra：宿主拿它在父对话正在跑时派转交来的子任务 */
  onOrchestra?: EngineHost['onOrchestra']
  childIsolation?: EngineHost['childIsolation']
  worktreeHome?: EngineHost['worktreeHome']
  branch?: EngineHost['branch']
  wrapUp?: EngineHost['wrapUp']
  p4Split?: EngineHost['p4Split']
  submitMerge?: EngineHost['submitMerge']
  finishChild?: EngineHost['finishChild']
  ueBuild?: EngineHost['ueBuild']
  peers?: EngineHost['peers']
  messagePeer?: EngineHost['messagePeer']
  verify?: EngineHost['verify']
  beginEdit?: EngineHost['beginEdit']
  inlineEdit?: EngineHost['inlineEdit']
  runBackground?: EngineHost['runBackground']
  checkBackground?: EngineHost['checkBackground']
  stopBackground?: EngineHost['stopBackground']
  lessons?: EngineHost['lessons']
}

/** 等用户确认的请求：请求 id → 把结果交回 CLI 的函数。只在内存里，服务重启后 CLI 进程也不在了 */
const replies = new Map<string, (r: AskReply) => void>()

/** 正在跑的一次 CLI 调用里能接收补充的那个：step 为空是对话，否则是工作流节点 */
interface Steerer {
  step: string
  agentId: string
  steer: (text: string) => Promise<boolean>
  /**
   * 补充交给了它：之后的输出另起一条，排在用户消息后面。
   * msg 是交出去的那条用户消息，这一轮最后没有任何输出时要靠它把消息捡回来重放
   */
  accepted: (msg?: TaskMessage) => void
}
/** 任务 id → 正在跑、能接收补充的调用（工作流里同时执行的节点可能有几个） */
const steers = new Map<string, Set<Steerer>>()
/** 工作流里正在跑的节点都收不了补充（Command Code）时，留给下一个开始的节点 */
const notes = new Map<string, string[]>()

/**
 * 回复完停在 wait_user_message 上等下一句的调用（任务 id → 它）。
 * 用户发消息时直接作为工具结果交回去，进程不用结束再 --resume；页面切走宽限到了就让它结束这一轮
 */
interface Waiter {
  /**
   * 用户发来下一句：记进对话再交给正在等的 CLI（placed 是拷进任务目录的那份，只有 CLI 用）。
   * recorded：消息早已记在对话里（排着等下一轮的那些），只交给 CLI、不再记一遍
   */
  deliver: (msg: TaskMessage, placed?: Attachment[], recorded?: boolean) => void
  /** 用户离开了：结束等待 */
  cancel: () => void
  /** 输入框里的 CLI/模型/强度还是启动这个进程时的那一套 */
  current: () => boolean
}
const waiters = new Map<string, Set<Waiter>>()

/**
 * 面板交给 CLI 的东西（一句话、工具结果、一次模型请求）之后多久一点输出都没有，算「没有响应」。
 * 模型正常都在几秒内开始输出（思考也是流式的）；测试用环境变量缩短
 */
const NO_RESPONSE_MS = Number(process.env.AGENT_PANEL_NO_RESPONSE_MS) || 90_000
/** 只说明 CLI 收下了、不说明模型在回的事件：不算有了响应 */
const NOT_RESPONSE = new Set(['session', 'turn', 'limits', 'request_start', 'files_changed', 'context'])
/** 任务 id → 卡住的这一轮（没得到回应的那条输入）：下一条消息据此停掉卡住的 CLI、接回会话重开 */
const stalled = new Map<string, { input: string; since: number }>()
export const stalledTurn = (taskId: string) => stalled.get(taskId)

/** 插话收下后还算「同一段输出」的事件：不产生新内容（见 runAgent 的 cutAfter） */
const CONTINUES = new Set(['session', 'turn', 'limits', 'usage', 'gen', 'context', 'files_changed'])
/**
 * 这个事件还属于正在输出的那一段（cur）：同一段正文、思考的增量，和不产生内容的用量、会话这些事件。
 * 换成工具、新一次模型回应、正文之后又开始思考，这一段就说完了
 */
export const continuesOutput = (ev: CliEvent, cur: TaskMessage | undefined) => {
  if (CONTINUES.has(ev.type)) return true
  if (ev.type === 'text_delta') return !!cur?.text.trim()
  if (ev.type === 'thinking') return !!cur?.thinking && !cur.text.trim() && !cur.tools.length
  return false
}

/** 预热时不记进对话的事件：正文、思考、工具和待办 */
const PREWARM_QUIET = new Set(['thinking', 'gen', 'text_delta', 'text', 'tool', 'tool_result', 'tool_delta', 'todos'])

/**
 * 把用户消息交给正在等下一句的 CLI。
 * 没有在等时返回 none；等着的进程已经不是输入框里的选择时返回 stale，
 * 调用方等它退出后按新的选择重新开始，不能把消息交给旧 CLI。
 */
export function deliverWait(
  task: Task,
  msg: TaskMessage,
  placed?: Attachment[],
  recorded = false,
): 'ok' | 'stale' | 'none' {
  const w = waiters.get(task.id)?.values().next().value
  if (!w) return 'none'
  if (!w.current()) {
    w.cancel()
    return 'stale'
  }
  w.deliver(msg, placed, recorded)
  return 'ok'
}

/**
 * CLI 刚停到等下一句上：这一轮里没交出去、排着「这一轮结束后处理」的消息直接交给它。
 * 排着的消息原本要等整次执行结束才接着处理，可保活的进程不会结束——这一轮刚说完、还没停稳时到的
 * 后台命令结果、子对话回报、用户的话就一直排着，对话收不到（用户报过：后台命令结果没回来，对话一直卡着）
 */
function flushHeld(task: Task) {
  if (!hasHeld(task.id)) return
  const q = takeHeld(task.id)!
  const msg = task.messages.find((m) => m.id === q.id)
  if (msg?.role === 'user') msg.delivery = { how: 'wait', at: new Date().toISOString() }
  const got = deliverWait(
    task,
    msg ?? { id: q.id, role: 'system', agentId: '', step: '', text: q.text, tools: [], at: new Date().toISOString() },
    q.attachments,
    !!msg,
  )
  // 交不出去（进程已经换了一套 CLI）：放回去，由整次执行结束后接着处理
  if (got !== 'ok')
    holdForNextTurn(task.id, msg ?? ({ id: q.id, text: q.text, attachments: q.attachments } as TaskMessage))
}

/** 对话派出的子任务（不是工作流节点） */
const isHelperStep = (task: Task, id: string) => {
  const s = id ? task.steps.find((x) => x.id === id) : undefined
  return !!s && s.slot === 'sub'
}

/**
 * 对话停下等子任务时（回复完 CLI 就退出的，Claude Code、Codex），等用户的下一条消息：
 * 消息记进对话，交给引擎马上开一轮回复。停止、页面离开时返回 null，引擎只等子任务
 */
function waitChat(task: Task, signal: AbortSignal, changed: (flush?: boolean) => void): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      const set = waiters.get(task.id)
      set?.delete(w)
      if (!set?.size) waiters.delete(task.id)
      resolve(value)
    }
    const onAbort = () => done(null)
    const w: Waiter = {
      deliver: (msg, placed, recorded) => {
        if (!recorded) task.messages.push(msg)
        task.working = true
        changed(true)
        done(withAttachments(msg.text, placed ?? msg.attachments ?? []))
      },
      cancel: () => done(null),
      // 进程已经退出了，下一轮按输入框里现在的选择开
      current: () => true,
    }
    ;(waiters.get(task.id) ?? waiters.set(task.id, new Set()).get(task.id)!).add(w)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 用户离开了这个对话：让还在等下一句的 CLI 结束这一轮；返回有没有真的取消到 */
export function cancelWait(taskId: string) {
  let canceled = false
  for (const w of waiters.get(taskId) ?? []) {
    w.cancel()
    canceled = true
  }
  return canceled
}

/** 任务删掉了：还没被节点取走的补充也一起清掉，别一直留在内存里 */
export function forgetNotes(taskId: string) {
  notes.delete(taskId)
}

/**
 * 交给 CLI 的补充。对话里先让模型判断这条补充和当前任务的关系：
 * 相关就调整方向；无关就先做完手上的事，再处理这条，别把当前任务丢在半路。
 * 工作流里交给正在跑的节点，按原来的说法结合当前任务处理。
 * fromParent：父对话 / 面板发来的（状态询问、收尾提醒），不是用户补充；用「用户补充」的措辞会让模型
 * 把它当成无关信息先放着，子对话就不会回答状态询问了。
 */
export const steerNote = (text: string, chat: boolean, fromParent = false) => {
  // 补充是一条新的用户消息，重复一次语言要求，别让模型接着上一段换成别的语言
  const remind = promptLangReminder()
  if (fromParent)
    return (
      '父对话 / 面板在你执行中发来一条消息（不是用户发的补充）：\n' +
      '- 和当前任务有关（状态询问、交代任务、调整方向）：按它处理并回复；\n' +
      '- 无关：先简短说明会等当前任务完成后再处理，然后继续手上的事。\n\n' +
      `${remind}\n\n内容：\n${text}`
    )
  return chat
    ? '用户在你执行中补充了信息。先判断它和当前任务的关系：\n' +
        '- 相关（对当前任务的调整、修改或补充）：按它调整方向，继续当前任务；\n' +
        '- 无关：先简短说明会等当前任务完成后再处理，然后继续手上的事，不要现在开始做它；当前任务做完后再处理这条内容。\n\n' +
        `${remind}\n\n补充的内容：\n${text}`
    : `用户在执行中补充了信息，请结合它继续当前的任务：\n${remind}\n\n${text}`
}

/**
 * 执行中的补充：把信息交给正在跑的调用，CLI 在当前这一轮里接着处理。
 * 有插话协议的直接插话；没有协议但能用面板的工具取的（见 CLI 配置的 notes）登记给它取；
 * 工作流里交给所有正在跑的节点，它们都不支持（Command Code）时留给下一个开始的节点。
 * 消息在每一种情况下都立刻记进对话，让用户看得到；任务没在跑时返回 false，由调用方记进对话并等这一轮结束。
 */
export async function steerTask(
  task: Task,
  text: string,
  msg: TaskMessage,
): Promise<'steer' | 'notes' | 'next-node' | false> {
  // 对话里派出的子任务也登记了插话：用户的话是说给对话的，不交给它们（交过去会记在子任务名下，对话里看不到）
  const all = [...(steers.get(task.id) ?? [])].filter((s) => !(task.mode === 'chat' && isHelperStep(task, s.step)))
  const took: Steerer[] = []
  for (const s of all)
    if (await s.steer(steerNote(text, task.mode === 'chat', msg.peer?.rel === 'parent'))) took.push(s)
  if (took.length) {
    // 工作流里的补充记在节点上：不算任务的新要求（继续执行时不会把它当成要求重跑）
    const at = took[0]
    task.messages.push({ ...msg, step: at.step, agentId: at.step ? at.agentId : msg.agentId })
    for (const s of took) s.accepted(msg)
    return 'steer'
  }
  const takers = noteTakersOf(task.id)
  if (takers?.size) {
    // 对话的 CLI 没有插话协议：登记给正在跑的它，下一次调用 read_user_notes 时交给模型；
    // 这一轮结束还没取走的，由 runner 交给下一轮接着处理
    task.messages.push(msg)
    for (const k of takers) k.add(msg)
    return 'notes'
  }
  // 主 Agent 在调度（评估、整理结果）时也算工作流在跑：补充留给下一个开始的调用
  const running = task.steps.find((x) => x.status === 'running' && !x.parentId)
  if (!(task.mode === 'workflow' && running)) return false
  ;(notes.get(task.id) ?? notes.set(task.id, []).get(task.id)!).push(text)
  task.messages.push({ ...msg, step: running.id, agentId: msg.agentId })
  return 'next-node'
}

/** 留着的命令输出最多这么多字（只留最后一段，最新的输出最有用） */
/**
 * 补充排在正在执行的命令后面、命令跑了这么久还没完：停下命令让 CLI 马上处理补充（见 rpc.redirect）。
 * 会改文件、装依赖、跑测试的命令按这个阈值打断；只读命令（ls、rg、git log、git worktree list）
 * 跑完这批工具就会被取走，等它自然结束，真卡住了才按 REDIRECT_READONLY_AFTER_MS 兜底（见 redirect.ts）
 */
// 测试用环境变量缩短，免得端到端测试真的等
const REDIRECT_AFTER_MS = Number(process.env.AGENT_PANEL_REDIRECT_MS) || 8000
/** 只读命令卡住时的兜底：比普通命令宽得多，让读代码、看历史的命令先跑完 */
const REDIRECT_READONLY_AFTER_MS =
  Number(process.env.AGENT_PANEL_REDIRECT_READONLY_MS) || Math.max(REDIRECT_AFTER_MS * 5, 40_000)
/** 停下命令后跟补充一起交给模型的说明 */
const REDIRECT_NOTE =
  '（面板说明：用户在你执行命令时发来了下面的消息。为了马上回应，刚才还在执行的命令已被中断：这条命令已经取消，它的输出不完整，不要当成结果使用。先回应用户；之后如果还需要那条命令的结果，重新执行。需要等待的命令（sleep、轮询 CI、长时间的测试或编译）不要在前台阻塞，用后台命令执行或直接告诉用户你在等什么。）'
const MAX_LIVE_OUTPUT = 8000
const tail = (s: string) => (s.length > MAX_LIVE_OUTPUT ? '…' + s.slice(-MAX_LIVE_OUTPUT) : s)

/** 对话撤回、分叉后 CLI 不能截断会话时，把留下的对话整理成文字带给新会话 */
function transcript(task: Task, upto: number) {
  const lines: string[] = []
  for (const m of task.messages.slice(0, upto)) {
    if (m.step || m.role === 'system' || !m.text.trim()) continue
    const text = m.role === 'user' ? withAttachments(m.text, m.attachments) : m.text
    // 父对话交代的任务、回答 role 也是 user：说清是父对话说的，新会话别当成用户的话
    const who = m.role === 'user' ? (m.peer ? `父对话「${m.peer.title || m.peer.name}」` : '用户') : '你'
    lines.push(`${who}：${text.trim()}`)
  }
  return lines.join('\n\n')
}

/** 上下文超长降级时带给新会话的对话最多占模型窗口的多少：剩下的留给角色设定、提示词和这一轮的要求 */
const CONTEXT_CARRY_SHARE = 0.4
/**
 * 正文至少要有这么多 token 才值得截断保留，不够就换成一行「正文太长，这里省略」：
 * 再短的话截出来的头尾只剩几个字，不如把预算留给工具行和更近的消息
 */
const MIN_CLIP_TOKENS = 200

/**
 * 一轮以「上下文超长」失败时怎么自救：
 * - `compact`：这一次是压缩请求。压缩本身要把历史整段重发，模型照样会拒，改用面板裁剪的记录当摘要，按压缩成功返回
 * - `restart`：普通一轮。丢掉旧会话、把对话裁剪到预算内换成新会话接着做
 * - `null`：不自救，照原来的失败处理。已经降过一次（`retried`）就如实报错，不能无限重开；
 *   预热请求不碰对话记录；用户已经停了；这一轮本来没有可裁剪的历史
 *
 * 只认「上下文超长」这一种报错：别的 400 和网络错误各有自己的处理路径，不能被这里顺手改写
 */
export function contextFallbackKind(input: {
  detail: string
  retried: boolean
  prewarm: boolean
  aborted: boolean
  compact: boolean
  /** 这一轮是带历史的对话续接：只有这样的轮次才有旧会话可丢、有记录可裁剪 */
  chatResume: boolean
}): 'compact' | 'restart' | null {
  if (input.retried || input.prewarm || input.aborted) return null
  if (classifyError(input.detail) !== 'context') return null
  if (input.compact) return 'compact'
  return input.chatResume ? 'restart' : null
}

/** 按估算的 token 数截断一段文字：留开头和结尾，中间省略（结论通常在这两处） */
function clipTokens(s: string, budget: number) {
  const est = estTokens(s)
  if (est <= budget) return s
  // estTokens 对中日韩按字数、其余按四分之一字数估算，按比例折成字符数足够近似
  const keep = Math.max(80, Math.floor((s.length * budget) / est))
  const head = Math.floor(keep * 0.6)
  return `${s.slice(0, head)}\n\n…（中间省略 ${s.length - keep} 个字）…\n\n${s.slice(-(keep - head))}`
}

const TOOL_WORD: Record<ToolUse['kind'], string> = {
  read: '读取',
  edit: '修改',
  run: '运行',
  search: '搜索',
  web: '联网',
  skill: '技能',
  agent: '子对话',
  compact: '压缩',
  other: '工具',
}
/** 最近几条消息的工具调用保留完整；更早的只按类别计数（走时间越久越简，不然旧细节占掉大半预算） */
const RECENT_CLIP_ITEMS = 4
/** 一条消息最多列几项工具调用：再多就折成「等 N 项」，否则工具行自己会把预算吃光 */
const MAX_CLIP_TOOLS = 8
/** 工具标签（文件名、命令原文）最多留这么多字：够认出来做了什么，又不会一个标签就吃光一条消息的预算 */
const MAX_CLIP_TOOL_LABEL = 120

/** 一条消息里的工具调用（包括面板 MCP 工具：派子对话、后台命令、计划、传话）压成一行。 */
function toolLine(tools: ToolUse[]) {
  const seen = new Set<string>()
  const items: string[] = []
  for (const [i, t] of tools.entries()) {
    const name = t.name?.trim() || TOOL_WORD[t.kind]
    const label = clip(t.label.trim(), MAX_CLIP_TOOL_LABEL)
    const one = label ? `${name} ${label}` : name
    if (seen.has(one)) continue
    seen.add(one)
    items.push(t.failed ? `${one}（失败）` : one)
    if (items.length >= MAX_CLIP_TOOLS) {
      const rest = tools.length - i - 1
      if (rest > 0) items.push(`等 ${rest} 项`)
      break
    }
  }
  return items.length ? `（工具：${items.join('；')}）` : ''
}

/** 很久以前那几条消息的工具调用：只按类别计数（读过哪些文件已经不重要，做过哪类事还在） */
function briefToolLine(tools: ToolUse[]) {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const word = TOOL_WORD[t.kind]
    const key = t.failed ? `${word}（失败）` : word
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const items = [...counts].map(([word, n]) => `${word}×${n}`)
  return items.length ? `（早先的工具：${items.join('；')}）` : ''
}

/**
 * 上下文已经超过模型上限时的续接内容：把对话裁剪到 token 预算之内。
 * 原来的历史已经证明发不出去（请求被 400 拒绝），带给新会话的文字必须自己受预算约束：
 * 从最新的消息往前留，更早的折成一行说明，单条过长的正文截断成头尾两段。
 * 工具调用行优先占预算：正文放不下时让位给工具，工具本身也放不下才整条省略；
 * 工具本身按时间分层：最近几条保留完整（文件名、命令原文），更早的只压成类别计数。
 * 面板 MCP 工具清单本身不靠这段文字：开新会话时 orchHint 会重新注入，这里只保留调用记录
 */
export function clippedTranscript(task: Task, upto: number, budget: number) {
  const items: { who: string; text: string; tools: string }[] = []
  const all = task.messages.slice(0, upto).filter((m) => !m.step && m.role !== 'system' && m.text.trim())
  for (const [i, m] of all.entries()) {
    const text = m.role === 'user' ? withAttachments(m.text, m.attachments) : m.text
    const who = m.role === 'user' ? (m.peer ? `父对话「${m.peer.title || m.peer.name}」` : '用户') : '你'
    // 最近几条看得见细节，更早的按「做过哪类事」计数就够
    const brief = i < all.length - RECENT_CLIP_ITEMS
    items.push({ who, text: text.trim(), tools: brief ? briefToolLine(m.tools) : toolLine(m.tools) })
  }
  const kept: string[] = []
  let used = 0
  let omitted = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const { who, text, tools } = items[i]
    const toolCost = tools ? estTokens(tools) : 0
    const left = budget - used
    // 连工具行都放不下：这一条和更早的消息一起省略（不能只留正文丢工具）
    if (toolCost > left) {
      omitted = i + 1
      break
    }
    const room = left - toolCost
    const line = `${who}：${text}`
    let body: string
    if (estTokens(line) <= room) body = line
    else if (room >= MIN_CLIP_TOKENS) body = `${who}：${clipTokens(text, room)}`
    // 正文挤不下就让它让位：工具调用照留，新会话至少知道这一轮做了什么
    else body = `${who}：（正文太长，这里省略，这一轮做了什么见下面的工具）`
    kept.unshift(tools ? `${body}\n${tools}` : body)
    used += estTokens(body) + toolCost
  }
  const head = omitted > 0 ? t('（更早的 {n} 条消息因为太长省略了）', { n: omitted }) : ''
  return [head, ...kept].filter(Boolean).join('\n\n')
}

/** 新会话接手旧对话：先压缩上下文，再继续；已经做完的不要重做 */
function carryPrompt(task: Task, upto: number) {
  return [
    '## 之前的对话',
    transcript(task, upto),
    '',
    '请先把上面的对话压缩成继续任务需要的上下文摘要（要做的事、已经完成的工作、关键决定和原因、还没做完的部分），',
    '再完成「现在的要求」；已经做完的不要重做。',
  ].join('\n')
}

/** 审查改动时给不支持审查模式的 CLI 的要求 */
function reviewPrompt(target: Extract<NonNullable<BuildOptions['op']>, { kind: 'review' }>['target']) {
  const what =
    target.type === 'base'
      ? `当前分支相对 ${target.branch} 的改动（git diff ${target.branch}...HEAD）`
      : target.type === 'custom'
        ? target.instructions
        : '工作区里还没提交的改动（git diff HEAD，包括新建的文件）'
  return [
    `请审查${what}。`,
    '只审查，不要修改任何文件。',
    '按严重程度从高到低列出发现的问题：每条写明文件和行号、问题是什么、为什么是问题、建议怎么改。',
    '重点看会导致错误行为的问题（逻辑错误、边界情况、并发、安全、资源泄漏），其次是可维护性；不要列纯粹的格式问题。',
    '没有发现问题就直接说没有问题。',
  ].join('\n')
}

/** Command Code 不能压缩会话：请它把对话整理成摘要，下一轮开新会话时带上 */
const SUMMARY_PROMPT =
  '请把我们到目前为止的对话整理成一份摘要，用于在新的会话里继续工作：包括要做的事、已经做了什么（改了哪些文件、关键的决定和原因）、' +
  '还没做完的、需要注意的问题。只输出摘要本身，不要做别的事，也不要修改文件。'

const stepTitle = (task: Task, id: string) => task.steps.find((s) => s.id === id)?.title ?? ''

/** 「提问」开关关掉了：还在等回答的问题让 CLI 自己选 */
export function autoAnswerQuestions(task: Task) {
  for (const req of task.requests.filter((x) => x.kind === 'question')) {
    const fn = replies.get(req.id)
    if (!fn) continue
    replies.delete(req.id)
    task.requests = task.requests.filter((x) => x.id !== req.id)
    fn(AUTO_ANSWER)
  }
}

/**
 * 用户停止对话（提问窗口的关闭就是不回答、终止对话）：还在等回答的请求马上作废，页面上的提问立刻收起。
 * 不能等这一轮的进程结束再清：保活的 CLI 卡在等回答时这一轮不会结束，提问就一直关不掉。
 * 工作流节点的确认不在这里处理：它跟着停止信号自己收掉，继续执行时重新确认
 */
export function dropRequests(task: Task) {
  const drop = task.requests.filter((x) => x.kind !== 'confirm')
  if (!drop.length) return false
  task.requests = task.requests.filter((x) => x.kind === 'confirm')
  for (const req of drop) {
    const fn = replies.get(req.id)
    replies.delete(req.id)
    fn?.({ allow: false, message: '用户不回答这个问题，终止了对话：先不要继续，等用户的下一条消息。' })
  }
  return true
}

/** 用户在任务页上回答了请求；找不到（已经结束、已回答过）时返回 false */
export function answerRequest(task: Task, id: string, r: AskReply, newId: () => string) {
  const fn = replies.get(id)
  const req = task.requests.find((x) => x.id === id)
  if (!fn || !req) return false
  replies.delete(id)
  task.requests = task.requests.filter((x) => x.id !== id)
  const what =
    req.kind === 'confirm'
      ? r.allow
        ? t('你确认了「{title}」的结果，接着往下执行', { title: stepTitle(task, req.step) })
        : t('你退回了「{title}」：{answer}', { title: stepTitle(task, req.step), answer: r.answer ?? '' })
      : req.kind === 'question'
        ? req.questions && req.questions.length > 1 && r.answers?.length
          ? t('你回答了：{answers}', {
              answers: req.questions.map((q, i) => `${q.question} → ${r.answers?.[i] ?? ''}`).join('；'),
            })
          : !r.allow
            ? t('你没有回答「{title}」', { title: req.title })
            : t('你回答了「{title}」：{answer}', { title: req.title, answer: r.answers?.[0] ?? r.answer ?? '' })
        : r.allow
          ? t('你允许了：{title}', { title: req.title })
          : t('你拒绝了：{title}', { title: req.title })
  // 回答了问题：问题和答案在对话正文里显示，不再是一行灰色的说明
  const answers = req.kind === 'question' ? questionAnswers(req, r) : undefined
  // 请求处理完就继续执行：等待结算进 waitMs，从这一刻重新算执行时间
  if (!task.requests.length) resumeRun(task)
  task.messages.push({
    id: newId(),
    role: 'system',
    agentId: req.agentId,
    step: req.step,
    text: what,
    tools: [],
    at: new Date().toISOString(),
    ...(answers ? { answers } : {}),
  })
  fn(r)
  return true
}

/** 估算一段文字的 token 数：中日韩字符约一个字一个 token，其余约四个字符一个 token。只用于显示实时速度 */
export function estTokens(s: string) {
  const cjk = s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0
  return cjk + (s.length - cjk) / 4
}

/**
 * 实时输出速度：最近 3 秒内流式输出的 token 数 ÷ 时间。CLI 只在一次请求结束时才报告真实的输出 token，
 * 所以先按字数估算，拿到真实数字后按「真实 ÷ 估算」校准。
 */
function speedMeter(onIdle: () => void) {
  const WINDOW = 3000
  let samples: [number, number][] = []
  let est = 0
  let real = 0
  let lastAt = 0
  let genMs = 0
  let tps = 0
  const ratio = () => (est > 50 && real > 0 ? Math.min(3, Math.max(0.5, real / est)) : 1)
  const timer = setInterval(() => {
    if (tps && Date.now() - lastAt > 1500) {
      tps = 0
      samples = []
      onIdle()
    }
  }, 500)
  return {
    /** 流式输出了一段文字；返回新增的生成时间（毫秒） */
    add(text: string) {
      const now = Date.now()
      const gap = lastAt ? now - lastAt : 0
      // 两段输出间隔太久（在跑工具）不算生成时间
      const add = gap < 2000 ? gap : 0
      genMs += add
      lastAt = now
      est += estTokens(text)
      samples.push([now, est])
      while (samples.length > 2 && now - samples[1][0] > WINDOW) samples.shift()
      const [t0, e0] = samples[0]
      const dt = (now - t0) / 1000
      tps = dt > 0.3 ? ((est - e0) / dt) * ratio() : tps
      return add
    },
    real(n: number) {
      real += n
    },
    get tps() {
      return Math.round(tps * 10) / 10
    },
    stop() {
      clearInterval(timer)
      tps = 0
    },
  }
}

/** 连接断开时自动续接的次数上限 */
const MAX_NET_RETRIES = 2

/**
 * 环境性失败（请求超时，但进程还活着、一个字都没输出）自动重试的次数上限。
 * 只重试一次：高负载时多等一会儿就能过，等两轮都过不了说明不是等待时间的问题
 */
const MAX_ENV_RETRIES = 1

/**
 * 桥接扩展加载预算：从 CLI 定义里读（mcp.vars.loadBudget），不在这里写死。
 * 没有这个变量的 CLI（codex / claude / commandcode）没有「启动时要把扩展装完」这段预算，返回 0
 */
export function envStallBudget(cliId: string) {
  const budget = Number(getCli(cliId)?.mcp?.vars.loadBudget)
  return Number.isFinite(budget) && budget > 0 ? budget : 0
}

/**
 * 环境性失败重试那一轮的请求超时。
 * 默认的 15 秒是「桥接扩展加载预算 10 秒 + 5 秒给 CLI 冷启动和回包」（见 docs/modules/server-exec/bugs/pi-bridge-tools-timeout.md），
 * 高负载时这段预算会被挤爆；重试轮再留一整份加载预算，25 秒足够覆盖，又不至于让用户白等更久
 */
export function envStallTimeout(cliId: string) {
  return REQUEST_TIMEOUT_MS + envStallBudget(cliId)
}

/**
 * 这一轮该不该因为环境性失败自动重试：只有「进程活着、没有任何响应」的超时算，
 * 模型明确报错、工具失败这些内容性失败不带标记，不会走到这里。
 * 没有加载预算的 CLI 不重试：放宽不了等待，原样重跑一遍既没用、也会让留痕里的「放宽到」说谎
 */
export function shouldRetryEnvStall(o: {
  /** 结果事件带的环境性卡住标记（session 层判定的） */
  stall: boolean
  /** 这一轮已经自动重试过几次 */
  retries: number
  aborted: boolean
  prewarm: boolean
  /** 桥接扩展加载预算（毫秒）：大于 0 才放宽得了 */
  budget: number
}) {
  return o.stall && !o.prewarm && !o.aborted && o.budget > 0 && o.retries < MAX_ENV_RETRIES
}

/** 环境性失败重试前写进对话的说明 */
export function envStallNote(timeoutMs: number, n = MAX_ENV_RETRIES) {
  return t('这一轮没有响应，已自动重试 {n} 次（等待放宽到 {wait}）…', { n, wait: fmtDuration(timeoutMs) })
}

/** 重试也没等到响应时，失败卡片上追加的原因：让用户知道面板已经试过一次 */
export function envStallFailure(n: number) {
  return t('已自动重试 {n} 次，仍然没有响应。', { n })
}

/**
 * 这一轮结束后要不要留着进程等用户下一句（面板保活）：对话模式、不是压缩/审查这类操作、CLI 定义开了 keepAlive。
 * 和 rpc.nativeAsk 无关：那只决定提问和审批走 CLI 自己的协议还是面板的 MCP 工具（见 invoke.ts 的 canTake），
 * 进程能不能留着开下一轮是另一件事；两者混在一起会让原生提问的常驻协议白白每轮重启。
 */
/** 会话压缩过：之前发过的规则段落只剩摘要，下一轮对话按完整提示重发（见 shared/prompt-delta.ts） */
export function forgetPromptSent(task: Task, sessionKey: string) {
  if (!task.promptSent?.[sessionKey]) return
  const { [sessionKey]: _gone, ...rest } = task.promptSent
  task.promptSent = rest
}

export function canKeepAlive(o: { chat: boolean; op: boolean; cliKeepAlive: boolean }) {
  return o.chat && !o.op && o.cliKeepAlive
}

/**
 * 这一轮是不是「什么都没收到」：CLI 报了一轮结束，却没有正文、没调工具、没改文件。
 * 这是 CLI 或网关出了问题（网关吞了请求、带图请求被拒），按错误显示给用户，不自动重试。
 * 不再按回复文字猜「只说了一句准备语」：用户 2026-10-29 要求去掉，寒暄、反问这类正常回复会被误判
 * 成没做完，还白白多跑一轮。只说了一句就收尾的回复照常收尾，由用户决定要不要接着说。
 * 「什么都没收到」仍然要拦：否则这一轮会被当成已完成并保活等下一句，
 * 用户发来的消息全落在死回合里，既没有回复也没有报错（见 docs/lessons/execution.md）。
 */
export function silentTurn(o: {
  /** 这一轮产生的所有回复 */
  texts: string[]
  /** 这一轮调用过的工具数 */
  tools: number
  /** 这一轮改过的文件数 */
  changed: number
}) {
  return !o.tools && !o.changed && !o.texts.some((x) => x.trim())
}

/** 自动续接前写进对话的报错：续接成功后要收回成普通说明 */
export interface NetNote {
  msg: TaskMessage
  base: string
  n: number
}

/** 环境性失败重试前写进对话的提示：重试成功要收成普通说明 */
export interface EnvStallNote {
  msg: TaskMessage
  base: string
}

/**
 * 重试成功了：这一轮其实做成了，那张红色卡片要收成普通说明，
 * 否则用户会以为这一轮失败了（和断流续接、空回合续一轮一个道理）
 */
export function settleEnvStallNotes(notes: EnvStallNote[]) {
  for (const { msg, base } of notes) {
    msg.error = undefined
    msg.transient = true
    msg.text = [base, '', t('已自动重试 {n} 次，这一轮继续做完了。', { n: MAX_ENV_RETRIES })].join('\n')
    if (msg.alert) msg.alert = { ...msg.alert, level: 'warn', resolved: t('已自动重试，继续做完了') }
  }
}

/**
 * 续接成功了：之前那次断开的报错已经不成立，收成普通说明。
 * 不收的话对话里会一直挂着一张红色的「执行失败」卡片，用户以为这一轮失败了。
 */
export function settleNetNotes(notes: NetNote[]) {
  for (const { msg, base, n } of notes) {
    msg.error = undefined
    msg.transient = true
    msg.text = [base, '', t('已自动续接会话（第 {n} 次），从中断的地方继续了。', { n })].join('\n')
    if (msg.alert) msg.alert = { ...msg.alert, level: 'warn', resolved: t('已自动续接，从中断的地方继续了') }
  }
}

/** 上下文超长、丢掉旧会话换成裁剪后的新会话时写进对话的提示：接上了要收回成普通说明 */
export interface ContextNote {
  msg: TaskMessage
  base: string
}

/**
 * 裁剪后的新会话接上了：那张「执行失败」卡片要收成普通说明。
 * 不收的话后面每一轮都看着像失败了，而这轮其实已经继续做下去了。
 */
export function settleContextNotes(notes: ContextNote[]) {
  for (const { msg, base } of notes) {
    msg.error = undefined
    msg.transient = true
    msg.text = [base, '', t('已丢掉旧会话，把对话裁剪后开新会话接着做了。')].join('\n')
    if (msg.alert) msg.alert = { ...msg.alert, level: 'warn', resolved: t('已裁剪对话，新会话接上了') }
  }
}

/**
 * 重试成功了：把本轮那张（或几张）「正在重试」收成已恢复（界面上变灰，不用再处理）。
 * from 是本轮在 messages 里的起点（runAgent 进来时的长度）：轮次由索引定，不按「最后一条用户消息」猜——
 * 执行中用户插话会往同一轮里再 push 一条 user，按 role 找边界会把它误当成新的一轮，卡就永远收不掉。
 * 返回是否真收到了一张：没有就不再多插一行「重试成功」。
 */
export function settleRetryNotes(messages: TaskMessage[], note: string, from = 0): boolean {
  let settled = false
  for (let i = messages.length - 1; i >= from; i--) {
    const tools = messages[i].tools
    for (let j = tools.length - 1; j >= 0; j--) {
      const alert = tools[j].alert
      if (alert?.kind !== 'retry' || alert.resolved) continue
      tools[j] = { ...tools[j], alert: { ...alert, resolved: note } }
      settled = true
    }
  }
  return settled
}
const NETWORK_ERROR =
  /Connection error|APIConnectionError|Unable to connect to the API|Failed to process successful response|Stream connection failed|stream (disconnected|closed|error)|ECONNRESET|ETIMEDOUT|socket hang up|network (error|connection)/i

/** 断流和上游网关断开算同一种网络问题：给连接中断的说明，有会话时自动续接 */
const isNetError = (detail: string) => NETWORK_ERROR.test(detail) || isGatewayError(detail)

/**
 * 会话在别的项目目录里，CLI 要求交互确认才继续（Pi 的「Session found in different project ... Fork this session into current directory?」）。
 * 面板里没有交互终端，答不了这个问，CLI 直接按 Aborted 退出。撞上了丢掉会话重开
 */
const SESSION_OTHER_PROJECT = /Session found in different project|Fork this session into current directory/i

/** 模型不支持调整思考强度：去掉 --effort 重跑一次，并在进程内记住 */
const EFFORT_REJECTED =
  /推理强度不可调整|推理强度.{0,10}(不支持|无法)|(effort|reasoning).{0,40}(not (supported|available|adjustable)|can't|cannot|unable)|(not (supported|adjustable)|can't|cannot|unable).{0,40}(effort|reasoning)/i

const NOT_LOGGED_IN =
  /Please run \/login|Invalid API key|not logged in|log ?in (again|first)|authentication[_ ](error|failed)|OAuth token (has )?expired|token (has )?expired|401 Unauthorized|codex login|refresh token|No API key found/i

/** 各个 CLI 登录的方法：在终端里照着做 */
const loginHow = (cli: string) =>
  ({
    claude: t('运行 claude，在里面输入 /login'),
    codex: t('运行 codex login'),
    commandcode: t('运行 cmdc，按提示登录'),
    pi: t('运行 pi，在里面输入 /login'),
  })[cli] ?? t('运行它并按提示登录')

/** 把常见的 CLI 报错翻译成能照着做的说明，原始输出另外附在后面 */
export function failureHints(detail: string, cli?: { id: string; name: string }) {
  const hints: string[] = []
  if (NOT_LOGGED_IN.test(detail))
    hints.push(
      t('· {cli} 好像没有登录，或者登录已经过期。请在终端里{how}，登录后回来点「继续执行」。', {
        cli: cli?.name ?? 'Agent',
        how: loginHow(cli?.id ?? ''),
      }),
    )
  const byok =
    /"([^"]+)" routes via Command Code; your providers\.json also declares it — use ((?:"[^"]+"(?: or )?)+)/.exec(
      detail,
    )
  if (byok) {
    const alt = [...byok[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(t(' 或 '))
    hints.push(
      t(
        '· 模型「{model}」走的是 Command Code 官方服务，不是你在 providers.json 里接的接口。想用自己的接口，请把模型换成「{alt}」（模型下拉的「配置文件」分组里）。',
        { model: byok[1], alt },
      ),
    )
  }
  if (isNetError(detail))
    hints.push(
      t(
        '· 和模型服务的连接中途断开了。常见于一次要输出很长的内容（例如写入一个大文件）时，连接被服务端或代理断开；可以点「继续执行」重试，或者换一个接口、让角色分几次写。',
      ),
    )
  // Codex 的线程里存着上一个模型的工具调用时，换成别的模型后接口会一直拒绝这条历史
  if (/input\.content/i.test(detail))
    hints.push(
      t(
        '· 模型接口拒绝了这段聊天记录（input.content 无效或缺失）。常见于在同一个对话里换了模型：Codex 的会话里留着上一个模型的工具调用，新模型接不上。如果反复出现，请新建一个对话。',
      ),
    )
  return hints
}

/** 调用一次 Agent 对应的 CLI，把输出写进任务消息 */
/** 两个信号任一触发就触发（AbortSignal.any 要 Node 20.3+，包只要求 20） */
function anySignal(a: AbortSignal, b: AbortSignal) {
  const ac = new AbortController()
  const fire = (x: AbortSignal) => () => ac.abort(x.reason)
  if (a.aborted || b.aborted) ac.abort((a.aborted ? a : b).reason)
  else {
    a.addEventListener('abort', fire(a), { once: true })
    b.addEventListener('abort', fire(b), { once: true })
  }
  return ac.signal
}

/**
 * 正在跑的调用手里的 API 名额：任务 id + 节点 id（对话这一轮是空的）→ 名额。
 * 等下一句、等子任务、等别的 Agent 回答时让出，接着干之前再拿回（见 waitNext 和 yieldApiSlot）
 */
const apiSlots = new Map<string, ApiSlot>()
const slotKey = (taskId: string, step: string) => `${taskId}\n${step}`

/** 这次调用要用的 API：CLI 的登录方式是 API 时才有；账号登录不受并发上限管 */
function callApi(ctx: RealContext, call: AgentCall) {
  const id = ctx.agents.some((a) => a.id === call.agentId) ? call.agentId : aliasAgent(call.agentId)
  const found = id ? ctx.agents.find((a) => a.id === id) : { ...defaultAgent(), id: '', name: '', description: '' }
  // 找不到角色时由 runAgent 报错
  if (!found) return undefined
  const agent =
    call.tier !== undefined ? nodeAgentRun(found, call.tier, defaultCli(ctx.settings)) : withTaskModel(found, ctx.task)
  return cliSettings(ctx.settings, agentRun(agent, ctx.settings).cli).api
}

/**
 * 拿名额；满了就排队，排队时对话（或子任务、节点）上标出在等哪个 API、前面还有几个。
 * 排队的子任务、节点显示成「排队中」，拿到再回到执行中。停止信号到了返回 false
 *
 * 标记用 try/finally 无条件清：只清「这次排过队」会在复用别处排队时漏清（排队标记就会跟到任务结束）。
 * reason 区分开跑前排队还是让出后拿回，后者不显示成「排队等名额」。
 */
async function takeApiSlot(
  ctx: RealContext,
  step: TaskStep | undefined,
  slot: ApiSlot,
  signal: AbortSignal,
  reason: 'start' | 'yield' = 'start',
) {
  let before: TaskStep['status'] | undefined
  try {
    return await slot.take(signal, (ahead) => {
      // 队伍动了会反复回调：before 只在第一次记下，后面不再改状态
      const b = markApiWait(ctx, step, slot.name, ahead, reason)
      if (before === undefined) before = b
    })
  } finally {
    // 不管拿到、被停止还是被让出，标记都必须清：它只能表示「此刻真的在排队」
    clearApiWait(ctx, step, before)
  }
}

/**
 * 按 API 的并发上限执行一次调用（对话这一轮、子任务、工作流节点都从这里进）：
 * 先拿名额再启动 CLI，结束时还回去。名额按 API 计，没设上限的也记着数，改成有上限时马上按实际占用算
 */
async function gatedRunAgent(ctx: RealContext, call: AgentCall): Promise<AgentResult> {
  const api = callApi(ctx, call)
  if (!api) return runAgent(ctx, call)
  const key = slotKey(ctx.task.id, call.step?.id ?? '')
  const slot = new ApiSlot(api.id, api.name)
  const signal = call.signal ? anySignal(ctx.signal, call.signal) : ctx.signal
  // 预热只是把 CLI 启动好、等用户的第一句：先不占名额，等到消息再拿（见 waitNext）
  if (!call.prewarm && !(await takeApiSlot(ctx, call.step, slot, signal)))
    return { ok: false, stopped: true, error: t('已停止') }
  const prev = apiSlots.get(key)
  apiSlots.set(key, slot)
  try {
    return await runAgent(ctx, call)
  } finally {
    slot.drop()
    if (apiSlots.get(key) === slot) {
      if (prev) apiSlots.set(key, prev)
      else apiSlots.delete(key)
    }
  }
}

/**
 * 调用停下来等别人（wait_agents 等子任务、ask_main 等主 Agent 回答）时让出名额，等完再拿回：
 * 占着名额等子任务，子任务又在排队等名额，就互相等死了
 */
async function yieldApiSlot<T>(ctx: RealContext, stepId: string, wait: () => Promise<T>): Promise<T> {
  // 对话自己（@chat）不是一个节点，名额记在空的节点 id 下
  if (!ctx.task.steps.some((s) => s.id === stepId)) stepId = ''
  const slot = apiSlots.get(slotKey(ctx.task.id, stepId))
  if (!slot?.holding) return wait()
  slot.drop()
  try {
    return await wait()
  } finally {
    const step = stepId ? ctx.task.steps.find((s) => s.id === stepId) : undefined
    await takeApiSlot(ctx, step, slot, ctx.signal, 'yield')
  }
}

async function runAgent(
  ctx: RealContext,
  call: AgentCall,
  retried = false,
  netRetries = 0,
  retryCarry = '',
  /** 这一串自动续接里已经写进对话的报错：续接成功后要收回成普通说明 */
  netNotes: NetNote[] = [],
  /** 上下文超长降级时写进对话的提示：新会话接上了要收回成普通说明 */
  contextNotes: ContextNote[] = [],
  /** 这一轮因为环境性失败（进程活着却没有输出）自动重试过几次：只重试一次，不能循环 */
  envStalls = 0,
  /** 环境性失败重试时写进对话的提示：重试成功要收回成普通说明 */
  envStallNotes: EnvStallNote[] = [],
): Promise<AgentResult> {
  // 单独终止这一次调用（界面上终止一个子任务）：和整个任务的停止信号合在一起，后面统一看 ctx.signal
  if (call.signal && !retried) ctx = { ...ctx, signal: anySignal(ctx.signal, call.signal) }
  const { agentId, prompt, sessionKey } = call
  const step = call.step?.id ?? ''
  const { task, settings, project } = ctx
  // 本轮开始的索引：重试成功时只收这一轮以后的卡（用户插话会往同一轮里再 push user，不能按 role 猜边界）
  const turnStart = task.messages.length
  // agentId 为空表示这个对话不用 Agent 角色：直接用默认 CLI，不注入角色设定
  // 旧快照里记着已经合并删掉的角色时，按登记的转到合并目标（转成空就是不用角色）
  const id = ctx.agents.some((a) => a.id === agentId) ? agentId : aliasAgent(agentId)
  const found = id ? ctx.agents.find((a) => a.id === id) : { ...defaultAgent(), id: '', name: '', description: '' }
  if (!found) return { ok: false, error: t('找不到执行这一步的角色，可能已被删除') }
  // 工作流里的调用固定用默认 CLI 的档位；对话可以用 Agent 自己的 CLI，默认 Agent 还能临时换模型
  const agent =
    call.tier !== undefined ? nodeAgentRun(found, call.tier, defaultCli(settings)) : withTaskModel(found, task)
  const run = agentRun(agent, settings)
  const cliId = run.cli
  const def = getCli(cliId)
  if (!def) return { ok: false, error: t('未知的 Agent：{cli}', { cli: cliId }) }
  const cs = cliSettings(settings, cliId)
  if (!cs.enabled) return { ok: false, error: t('{cli} 在设置里被停用了', { cli: def.name }) }
  if (!agent.enabled) return { ok: false, error: t('角色「{name}」已停用', { name: agent.name }) }
  const cwd = project.path
  const dir = await stat(cwd).catch(() => null)
  if (!dir?.isDirectory()) return { ok: false, error: t('项目目录不存在：{dir}', { dir: cwd || t('（未设置）') }) }

  const model = run.model
  // 模型不认的思考强度会让 CLI 启动即报错退出：挡在这里，下面记下的启动命令和日志才和实际调用的参数一致
  // 模型目录里的默认思考强度：没有手动指定时用它；目录里没有的模型交给 CLI 自己决定
  const entries = await mergedModelCatalog().catch(() => [])
  // API 设置里给这个模型配了映射时，默认思考强度按映射到的模型算
  const catalogInfo = apiModelInfo(model, cs.api, entries)
  // API 设置里给这个模型配的默认思考强度优先，其次才是模型目录的默认值
  const defaultEffort =
    cs.api?.modelEfforts?.[apiModelKey(model, cs.api.modelEfforts)] ||
    (catalogInfo.matched ? catalogInfo.defaultEffort : '')
  const requested = run.effort || defaultEffort
  let effort = await supportedEffort(cliId, model, requested)
  // 模型不认 Agent 自己或档位给的强度时，再试档位 / 模型默认的强度，不能直接变成不传
  const fallback = (run.tier ? cs.tiers[run.tier.id].effort : '') || defaultEffort
  if (!effort && requested && fallback && fallback !== requested) effort = await supportedEffort(cliId, model, fallback)
  // 档位在设置里手动改过的上下文窗口和最大输出；0 是自动，用下面算出来的值
  const manual: ModelLimits = run.tier
    ? { context: cs.tiers[run.tier.id].context, maxOutput: cs.tiers[run.tier.id].maxOutput }
    : {}
  // 自动值也传给 CLI：Claude Code、Codex 只认全局的窗口（环境变量 / 配置），
  // 接第三方接口时模型不在它们认识的内置表里，不传就按默认窗口截断，压缩点会小很多。
  // 只传上下文：最大输出在它们那里也是全局的，按目录传会把这个 CLI 的所有模型都改成同一个值。
  // 目录里没有的模型不传，交给 CLI 自己判断
  const known = apiModelInfo(model, cs.api, entries)
  const limits: ModelLimits = {
    context: manual.context || (known.matched ? known.context : undefined),
    maxOutput: manual.maxOutput || undefined,
  }
  const op = call.op
  // 对话（不属于节点的调用）才能插话、分叉、撤回
  const chat = !step && sessionKey === task.agentId && task.mode === 'chat'
  const prewarm = chat && !!call.prewarm
  // 启动这一轮时的选择；执行中换了 CLI/模型/强度，或者面板语言变了（系统提示词和 mod 的环境变量固定在
  // 这个进程里，新消息的提醒却是新语言），结束时都不能还停在旧进程上等下一句
  const startPick = { cli: task.cli, model: task.model, effort: task.effort, lang: getLang() }
  const stillCurrent = () => {
    const now = agentRun(withTaskModel(found, task), settings)
    // 这一轮里开了独立分支：进程还在原目录里，不能再等下一句，结束后在新目录里重开
    const wt = task.worktree?.state === 'active' ? task.worktree.path : ''
    return (
      now.cli === cliId &&
      now.model === model &&
      task.effort === startPick.effort &&
      getLang() === startPick.lang &&
      (!wt || wt === cwd)
    )
  }
  // 预热期间的输出不记进对话；用户发来第一句后开始正常记
  let prewarmMode = prewarm
  let resume: string | undefined = task.sessions[sessionKey]
  let fork: BuildOptions['fork']
  let carry = ''
  // 触发这一轮的用户消息：结束后在它上面记下这一轮在 CLI 会话里的位置（预热没有触发消息）
  const asker =
    chat && !op && !prewarm ? [...task.messages].reverse().find((m) => m.role === 'user' && !m.step) : undefined
  const rewind = chat ? task.rewind : undefined
  // 对话中途换了 CLI、（不能中途换模型的 CLI 换了）模型或（不支持中途换强度的 CLI 换了）思考强度：
  // 原来的会话接不上，开新会话把之前的对话带过去。
  // 会话开在别的目录里（中途开了独立分支）也接不上：CLI 的会话按目录存，换了目录 --resume 找不到。
  // 子任务一样要查：父对话开了独立分支后，子任务的会话还留在原目录
  const moved = sessionMoved(task, sessionKey, cwd, chat)
  const switched =
    chat && (sessionChanged(task, cliId, model, effort, def.effortBoundSession, def.modelSwitch) || moved)
  if (switched) resume = undefined
  // 子任务没有「对话记录」可带：会话在别的目录里就丢掉，这次用完整提示新开一个
  else if (moved) resume = undefined
  if (retryCarry) {
    // 接口拒绝了旧会话的历史：丢掉它重开，把之前的对话带上
    resume = undefined
    carry = retryCarry
  } else if (rewind || switched) {
    const th = rewind?.through ?? null
    resume = undefined
    if (rewind?.summary) carry = `## 之前对话的摘要\n${rewind.summary}`
    else if (switched) {
      // 开了独立分支后接着做：触发这一轮的是面板，不是新的用户消息，上一轮的要求和回复都要带过去
      const upto = asker && !moved ? task.messages.indexOf(asker) : task.messages.length
      carry = carryPrompt(task, upto)
    } else if (th && def.fork === 'turn' && th.id) [resume, fork] = [th.session, { turnId: th.id }]
    else if (th && def.fork === 'end' && th.end) [resume, fork] = [th.session, { end: th.end }]
    // 只能分叉到某一轮之前（Pi）：按丢掉的第一轮截，那一轮要和留下的在同一个会话里
    else if (th && def.fork === 'before' && rewind?.cut?.id && rewind.cut.session === th.session)
      [resume, fork] = [th.session, { before: rewind.cut.id }]
    else if (th && rewind?.latest && def.fork !== 'none') [resume, fork] = [th.session, {}]
    else if (th) {
      // CLI 截不了会话：开新会话，把留下的对话（这条要求之前的）带上
      const upto = asker ? task.messages.indexOf(asker) : task.messages.length
      carry = carryPrompt(task, upto)
    }
  }
  // 只用已经读过的模型列表（设置页、Agent 页打开时会读），不为了查窗口再跑一次 CLI
  const catalog = cachedModels(cliId)?.models ?? []
  const files = await knownWindows(cliId)
  // 模型目录里没有时按 1M 估算；API 模式按当前接口的协议优先选
  const windowFor = (m: string) => {
    if (m === model && limits.context) return limits.context
    // API 设置里给这个模型配了映射：按映射到的模型配置查；CLI 收到的模型名不受影响
    const key = cs.api?.modelMap?.[m] || m
    return (
      catalog.find((x) => x.id === key || x.id.endsWith(`/${key}`))?.contextWindow ??
      files.get(key) ??
      files.get(key.slice(key.lastIndexOf('/') + 1)) ??
      autoLimits(key, catalog, { entries, protocol: cs.api?.protocol }).context
    )
  }
  const role = composeRole(agent, ctx.agents, call.params ?? (step ? {} : task.params), task.skillSlots).trim()
  /** 上下文超长降级时留给旧对话的 token 预算：剩下的给角色设定、提示词和这一轮的要求 */
  const carryBudget = () => Math.max(MIN_CLIP_TOKENS * 2, Math.floor(windowFor(model) * CONTEXT_CARRY_SHARE))
  // 支持系统提示词的 CLI：语言规则跟角色设定一起放系统提示词。模型的原生思考主要跟系统提示词走，
  // 只写在任务描述里时不一定遵守（实测 Command Code + DeepSeek 仍按英文系统提示词思考）
  const instructions = def.systemPromptFlag ? [role, promptLangRules()].filter(Boolean).join('\n\n') : role
  // Command Code 没有系统提示词参数，改用 --mod 加载的 mod 追加同一段规则（见 prompt-lang-mod.ts）
  const systemPromptModPath = def.systemPromptMod ? await ensurePromptLangMod() : undefined
  // Agent 要用的自带 Skill 统一补到 ~/.agents/skills，提示里点名的 Skill 才找得到
  await ensureBundled(
    fillSkills(
      [...new Set([...agent.skills, ...includedAgents(agent, ctx.agents).flatMap((x) => x.agent.skills)])],
      task.skillSlots,
    ),
  )
  // 调用方只发了增量（续接时省掉会话里已有的规则段落）、这次却没接上原来的会话（换了 CLI / 目录、回退、续不上）：
  // 新会话里什么都没有，改用完整的提示
  const base = !resume && call.fresh ? call.fresh : prompt
  let input = op?.kind === 'review' && def.review !== 'native' ? reviewPrompt(op.target) : base
  input = defaultChatPrompt(input, agentId, chat, !!op)
  // 之前的节点收不了的补充，交给这个节点
  const pending = step ? notes.get(task.id) : undefined
  if (pending?.length) {
    notes.delete(task.id)
    input = `${input}\n\n## 用户在执行中补充的信息\n${pending.join('\n\n')}`
  }
  if (op?.kind === 'compact') input = def.compact === 'slash' ? '/compact' : SUMMARY_PROMPT
  // 对话里打的「/命令」：Claude Code 新会话开头原样认得，其他情况展开成普通要求。
  // 对话提示把用户原话放在「## 用户这次的消息」下面，所以按原话判断，把那一行换成展开后的要求
  if (chat && !op && ctx.prompt.trim().startsWith('/')) {
    const head = '## 用户这次的消息\n'
    const at = input.indexOf(head + ctx.prompt)
    const expanded = await expandSlash(ctx.prompt, cliId, cwd, def.slash && !carry)
    if (at >= 0 && expanded !== ctx.prompt)
      input = `${input.slice(0, at + head.length)}${expanded}${input.slice(at + head.length + ctx.prompt.length)}`
  }
  if (carry) input = `${carry}\n\n## 现在的要求\n${input}`
  // 工作流里的调用带上编排工具（派子 Agent、查状态、提问、传话）；第一轮告诉它什么时候用，续接的会话里已经说过
  const orch = call.orch && def.mcp && !op ? call.orch : undefined
  if (orch && !resume) input = `${input}\n\n${orchHint(orch)}`
  // 项目教训：新会话开头带一次（全局条目全文 + 其余标题），按文件的全文由 Agent 用 project_lessons 自己取
  if (!resume && !op && task.projectId) {
    const lessons = lessonsPrompt(project.lessons ?? [], !!orch?.lessons, await readGlobalLessons())
    if (lessons) input = `${input}\n\n${lessons}`
  }
  // 没有系统提示词参数的 CLI 只在会话第一轮带角色设定。续接旧会话时角色变了（内置角色随版本更新、用户改了设定），
  // 把新版补发一次，旧对话再聊也按新角色做；以前开的会话没记过，按变了处理补一次
  const roleHash = instructions ? createHash('sha1').update(instructions).digest('hex').slice(0, 16) : ''
  const roleStale = !!resume && !op && !!roleHash && task.roleHashes?.[sessionKey] !== roleHash
  if (instructions && !def.systemPromptFlag && roleStale)
    input = `## 你的角色（已更新，以这一版为准，之前的角色设定作废）\n${instructions}\n\n${input}`
  if (instructions && !def.systemPromptFlag && (!resume || roleStale))
    task.roleHashes = { ...task.roleHashes, [sessionKey]: roleHash }
  if (instructions && !def.systemPromptFlag && !resume) {
    // 节点的角色设定放在各节点共用的部分（需求、工作流说明）后面：不同 Agent 的节点开头一样，按前缀匹配的缓存能命中
    const role = `## 你的角色\n${instructions}\n\n`
    const at = step ? input.indexOf(`\n\n${NODE_PART}\n`) : -1
    input = at < 0 ? role + input : `${input.slice(0, at + 2)}${role}${input.slice(at + 2)}`
  }
  const setup = input.length - base.length
  // 末尾再提醒一次：长提示词里夹在中间的规则容易被忽略。原生 /命令（Claude Code 新会话开头要原样认出）
  // 和压缩、审查（参数另有含义）不追加
  if (!op && !(chat && ctx.prompt.trim().startsWith('/'))) input = `${input}\n\n${promptLangReminder()}`
  // 输入构成：除了调用方给的提示，新会话开头补的角色设定（含系统提示词）、编排说明、项目教训也进了上下文；
  // 末尾的语言提醒每轮都有，算进面板规则
  call.onInput?.({
    setup: Math.max(0, setup) + (!resume && def.systemPromptFlag ? instructions.length : 0),
    rules: Math.max(0, input.length - base.length - setup),
    fresh: base !== prompt,
  })
  // 自动压缩：Claude Code 用环境变量，Codex 用配置（按上下文窗口换算成 token 数）；Command Code 由面板在一轮结束后压缩
  const pct = cs.autoCompact
  const build: BuildOptions = {
    model,
    effort,
    permission: agentPermission(agent, settings),
    extraArgs: [...cs.extraArgs, ...agent.extraArgs],
    maxTurns: cs.maxTurns || undefined,
    resume,
    fork,
    // 审查走 CLI 自己的审查模式，压缩走协议；其余的已经换成普通的一轮
    op: (op?.kind === 'compact' ? def.compact : def.review) === 'native' ? op : undefined,
    systemPrompt: def.systemPromptFlag && instructions ? instructions : undefined,
    systemPromptModPath,
    // 附件里只有图片拷进了任务目录；其余按原来的绝对路径交给 Agent，工作目录之外的那些要放行。
    // 节点交接的完整结果也在数据目录里
    addDirs: [
      ...attachmentAddDirs(
        task.messages.flatMap((m) => m.attachments ?? []),
        { cwd, uploadsRoot: UPLOADS_DIR },
      ),
      ...(existsSync(path.join(HANDOFF_DIR, task.id)) ? [path.join(HANDOFF_DIR, task.id)] : []),
    ],
    noEdit: chat && !!ctx.beginEdit,
    autoCompactTokens: pct && def.autoCompact === 'config' ? Math.floor((windowFor(model) * pct) / 100) : undefined,
    contextWindow: limits.context || undefined,
    maxOutput: limits.maxOutput || undefined,
    // 对话的标题交给能给会话起名的 CLI，在它自己的会话列表里认得出是哪个对话
    title: chat && task.title ? task.title : undefined,
  }
  const env = childEnv([
    ...cs.env,
    // mod 按它选语言规则（见 prompt-lang-mod.ts）
    ...(systemPromptModPath ? [{ key: PROMPT_LANG_ENV, value: getLang() }] : []),
    ...(pct && def.autoCompact === 'env' && def.autoCompactEnv
      ? [{ key: def.autoCompactEnv, value: String(pct) }]
      : []),
    // 用户在环境变量里自己写了同名的，以设置里这一档的值为准（写在后面）
    ...limitEnvVars(def, limits),
    ...noPushEnv(task, ctx.project.gitPolicy),
    ...(await searchExcludeEnv(ctx)),
  ])

  // 记下这次启动的命令，任务页里可以复制出来自己跑一遍排查问题；角色设定很长，用占位代替
  const argv = [
    cs.command,
    ...def.buildArgs(build).map((a) => (build.systemPrompt && a === build.systemPrompt ? t('<角色设定>') : a)),
  ]
  const owner = step ? task.steps.find((s) => s.id === step) : undefined
  if (owner) owner.command = argv
  else task.command = argv
  log.info('agent', `启动 ${def.name}`, { task: task.id, step, agent: agent.name, cwd, command: argv.join(' ') })

  // 节点开始前的改动统计，结束后相减得到这个节点改了什么
  const before = task.changes.map((c) => ({ ...c }))
  const touched = new Set<string>()
  // 只收集这次调用新产生的消息：同一个节点返工、续跑时，之前几次调用的输出不能再算进来
  const mine: TaskMessage[] = []
  /**
   * 当前这一轮从哪开始：保活时一个进程会连着处理好几条用户消息，mine 里堆着前几轮的回复。
   * 判「这一轮什么都没做」只能看这一轮自己的输出，不然前一轮的正文会把后面的空回合盖住，
   * 用户的消息落进死回合既没回复也没报错。input 是这一轮要处理的要求，空回合重试时重发它
   */
  let turnMark = { from: 0, touched: 0, input: call.prompt }
  const turnMsgs = () => mine.slice(turnMark.from)
  const turnTools = () => turnMsgs().reduce((n, m) => n + m.tools.length, 0)
  let cur: TaskMessage | undefined
  const texts: string[] = []
  const errors: string[] = []
  let result: Extract<CliEvent, { type: 'result' }> | undefined
  const newMsg = () => {
    cur = {
      id: ctx.newId(),
      role: 'agent',
      agentId,
      step,
      text: '',
      tools: [],
      // 对话中途可以换 CLI 和模型，每条回复记下自己用的
      ...(chat ? { run: { cli: cliId, model, effort } } : {}),
      at: new Date().toISOString(),
    }
    task.messages.push(cur)
    mine.push(cur)
    return cur
  }

  // CLI 报告过窗口后就以它为准，后面没带窗口的用量事件不要改回估计值
  let reported = false
  /** 这一轮收到过用量事件：一个都没收到时统计不可信，要告给用户（不能把 0 当成真没消耗） */
  let usageSeen = false

  // 中途换了模型（改了 Agent 或设置）：记录换成这次实际用的，CLI 报告了模型时再以报告的为准
  const prevUsage = task.usage.agents[agentId]
  if (prevUsage && prevUsage.model !== model) Object.assign(prevUsage, { model, window: windowFor(model) })
  if (owner) Object.assign(stepUsage(owner), { model, window: windowFor(model) })

  /** 这个 Agent 的用量记录，没有就建一条 */
  const au = (): AgentUsage => {
    const prev = task.usage.agents[agentId]
    if (prev) return prev
    return (task.usage.agents[agentId] = {
      context: 0,
      window: windowFor(model),
      model,
      tps: 0,
      lastTps: 0,
      outputTokens: 0,
      genMs: 0,
    })
  }
  const toolsById = new Map<string, ToolUse>()
  /**
   * 工具行还没建好就到了的输出增量（有的 CLI 先推输出、后报调用）。
   * 按 id 先攒着，等 tool 事件建好行时补上，不然开头这段输出会丢
   */
  const earlyDeltas = new Map<string, string>()
  // 还没跑完的工具调用什么时候开始的：结果到了算耗时
  const toolStart = new Map<ToolUse, number>()
  /** 结果到了（或者这一轮结束了还没等到结果）：记下跑了多久 */
  const endTool = (x: ToolUse) => {
    // 被打断、CLI 没报结果的调用也要收掉运行中标记，不然这一行会一直转圈
    delete x.running
    const t0 = toolStart.get(x)
    if (t0 === undefined) return
    toolStart.delete(x)
    x.ms = Date.now() - t0
    delete x.startedAt
  }
  // 正在思考的那条消息和第一段思考到达的时刻：思考之后来了别的输出，思考就结束了
  let thinkingOf: { m: TaskMessage; at: number } | undefined
  // 刚压缩完、还不知道压缩后多大：下一次报告上下文用量时补到这次压缩的工具调用上
  let compaction: { tool: ToolUse; before?: number } | undefined
  // 这一轮在 CLI 会话里的位置，结束后记在触发它的用户消息上（分叉、撤回用）
  const turn: { id: string; end: string } = { id: '', end: '' }
  // 改了文件就去 git 里重新读一次改动，更改面板边跑边更新；读得太勤会拖慢大仓库，最多一秒半一次
  let gitTimer: ReturnType<typeof setTimeout> | undefined
  let gitBusy = false
  const refreshChanges = () => {
    if (!ctx.isGit || gitTimer || gitBusy) return
    gitTimer = setTimeout(async () => {
      gitTimer = undefined
      gitBusy = true
      const changes = await gitChanges(cwd, task.baseline, task.baseRef, placedFiles(task)).catch(() => null)
      gitBusy = false
      if (changes && !finished) {
        task.changes = changes
        ctx.changed()
      }
    }, 1500)
  }
  let finished = false
  const meter = speedMeter(() => {
    au().tps = 0
    ctx.changed()
  })
  // 新的一轮从 0 开始显示；这一轮有输出后，没输出时接着显示最后一次的速度
  const u0 = au()
  u0.tps = 0
  u0.lastTps = 0
  const streamed = (text: string) => {
    const u = au()
    u.genMs = (u.genMs ?? 0) + meter.add(text)
    u.tps = meter.tps
    if (u.tps > 0) u.lastTps = u.tps
  }

  /**
   * 这一轮是不是什么都没收到（见 silentTurn）。
   * keepAlive 会在这里先挂起等用户下一句，runAgent 就一直不返回，收尾处的报错没机会写；
   * 所以判定要能在 result 到达时（保活之前）问一次，命中就不保活，让收尾处把错误报出来。
   */
  const emptyTurn = () => {
    if (prewarmMode || op || ctx.signal.aborted) return false
    // texts 要等进程结束后才汇总，这里直接用这次调用的消息，result 到达时就能判断
    const texts = turnMsgs()
      .filter((m) => m.role === 'agent')
      .map((m) => m.text)
    return silentTurn({ texts, tools: turnTools(), changed: touched.size - turnMark.touched })
  }
  /**
   * 这一轮结束的回调只发一次：CLI 的 result 和「回复完停在等下一句」都会走到 markTurnDone，
   * 两处都记会让子对话把同一个状态重复上报父对话（父对话里一条汇报显示两遍）。
   * 用户发来下一条消息、或者子任务的结果交回让 CLI 接着做，都算新的一段（见 listen 和 waitNext）。
   */
  let turnEnded = false
  const endTurn = () => {
    if (turnEnded) return
    turnEnded = true
    markTurnDone(task)
    ctx.onTurnEnd?.({ tools: turnTools() })
  }
  /**
   * 没有响应的检测（见 NO_RESPONSE_MS）：交出一句话、一个工具结果，或 CLI 开始一次模型请求时开始计时，
   * 之后有任何真正的输出就停。超时写一行警告、标成卡住；后来又有输出了，警告标成已恢复。
   * 只看对话：工作流里几个节点同时跑，卡住的是哪一个由空闲检测管
   */
  let armedAt = 0
  let armedInput = call.prompt
  let stallMsg: TaskMessage | undefined
  /** 计时起点之后已经有过输出：再停住就是「输出到一半停了」，不是「一直没开始」 */
  let midway = false
  const arm = (input?: string) => {
    if (!chat || op) return
    armedAt = Date.now()
    midway = false
    if (input !== undefined) armedInput = input
  }
  const heard = () => {
    // 有了输出也接着计时：模型（多是第三方网关）流到半句就断了、进程还活着时，页面会一直停在「等待模型」，
    // 用户只能自己停下再发。这一轮还在跑就从这次输出重新算，到点同样告诉用户
    armedAt = chat && !op && task.working ? Date.now() : 0
    midway = !!armedAt
    const st = stalled.get(task.id)
    if (!st) return
    stalled.delete(task.id)
    if (stallMsg?.alert && !stallMsg.alert.resolved) {
      stallMsg.alert = {
        ...stallMsg.alert,
        resolved: t('{s} 秒后有输出了，接着在处理', { s: Math.round((Date.now() - st.since) / 1000) }),
      }
      ctx.changed(true)
    }
  }
  const stallTimer = setInterval(
    () => {
      if (!armedAt || finished || prewarmMode) return
      // 在等用户、等子任务、等确认：本来就没有输出
      // 还有工具在跑（并行调用里先回来一个结果）：等的是工具，不是模型；排队等 API 名额时消息还没交给 CLI
      if (
        task.awaitingUser ||
        waitingHelpers ||
        task.apiWait ||
        toolStart.size ||
        task.requests.some((x) => asked.includes(x.id))
      ) {
        armedAt = Date.now()
        return
      }
      const quiet = Date.now() - armedAt
      if (quiet < NO_RESPONSE_MS) return
      const since = armedAt
      armedAt = 0
      stalled.set(task.id, { input: armedInput, since })
      const secs = Math.round(quiet / 1000)
      stallMsg = {
        id: ctx.newId(),
        role: 'system',
        agentId,
        step,
        text: midway
          ? t('{cli} 输出到一半停了，{s} 秒没有新的内容。直接再发一条消息，面板会停掉它、接回这个会话重新开始。', {
              cli: def.name,
              s: secs,
            })
          : t('{cli} 收到消息 {s} 秒了还没有任何输出。直接再发一条消息，面板会停掉它、接回这个会话重新开始。', {
              cli: def.name,
              s: secs,
            }),
        tools: [],
        alert: makeAlert(
          'warn',
          [
            midway
              ? t('{cli} 输出到一半后 {s} 秒没有新的输出（没有思考、正文或工具调用），模型的流可能断了。', {
                  cli: def.name,
                  s: secs,
                })
              : t('{cli} 在 {s} 秒里没有任何输出（没有思考、正文或工具调用）。', { cli: def.name, s: secs }),
            t('交给它的最后一条内容：'),
            clip(armedInput, 800),
          ].join('\n'),
          'no_response',
        ),
        at: new Date().toISOString(),
      }
      task.messages.push(stallMsg)
      log.warn('agent', `${def.name} 交出消息后 ${secs} 秒没有输出，标成卡住`, { task: task.id, step })
      ctx.changed(true)
    },
    Math.min(5000, Math.max(50, NO_RESPONSE_MS / 4)),
  )
  stallTimer.unref?.()
  const apply = (ev: CliEvent) => {
    // 有了真正的输出：不算卡住。工具结果交回去、开始一次模型请求后，重新开始等模型的回应
    if (!NOT_RESPONSE.has(ev.type)) heard()
    if (ev.type === 'tool_result' || ev.type === 'request_start') arm()
    // 预热时模型可能先回一句话再调用等待工具：这些不显示，也不占消息
    if (prewarmMode && PREWARM_QUIET.has(ev.type)) return
    // 插话收下时正在输出的那段话：说完再断开，用户的消息排在它后面，不把一句话从中间劈开
    if (cutAfter && !continuesOutput(ev, cur)) {
      cutAfter = false
      cur = undefined
    }
    // 延迟取走的补充：CLI 开始下一次模型请求时说明它真的接受了补充，之后的输出另起一条。
    // 消息本身在交出去时就已经记进对话，这里只断开输出
    if (steerPending && ev.type === 'request_start') {
      steerPending = false
      clearTimeout(redirectTimer)
      redirectTimer = undefined
      cur = undefined
      prewarmMode = false
      task.prewarming = false
      task.working = true
      ctx.changed(true)
    }
    if (thinkingOf && ev.type !== 'thinking' && ev.type !== 'usage' && ev.type !== 'limits' && ev.type !== 'session')
      thinkingOf = undefined
    switch (ev.type) {
      case 'session':
        task.sessions[sessionKey] = ev.id
        // 会话按目录存：每个会话都记下是在哪开的，续接前先看（子任务也一样）
        task.sessionDirs[sessionKey] = cwd
        if (chat) {
          task.sessionCli = cliId
          task.sessionDir = cwd
        }
        break
      case 'thinking': {
        // 思考属于接下来的那段回复：当前消息已经有文字或工具时另起一条
        const m = !cur || cur.text.trim() || cur.tools.length ? newMsg() : cur
        m.thinking = ev.delta ? (m.thinking ?? '') + ev.text : ev.text
        // CLI 报了这段用了多久就用它；否则从第一段到达算到最新一段，边想边更新
        if (ev.ms !== undefined) m.thinkingMs = (m.thinkingMs ?? 0) + ev.ms
        else {
          if (thinkingOf?.m !== m) thinkingOf = { m, at: Date.now() - (m.thinkingMs ?? 0) }
          m.thinkingMs = Date.now() - thinkingOf.at
        }
        streamed(ev.text)
        break
      }
      case 'gen':
        streamed(ev.text)
        break
      case 'text_delta': {
        if (!cur && !ev.text.trim()) break
        const m = cur ?? newMsg()
        m.text += ev.text
        streamed(ev.text)
        break
      }
      case 'text': {
        const m = cur ?? newMsg()
        m.text = m.text ? `${m.text.trimEnd()}\n\n${ev.text}` : ev.text
        break
      }
      case 'tool': {
        // 等下一句是面板内部的保活机制，不占一行工具调用
        if (ev.tool.label.includes('wait_user_message')) break
        const m = !cur || cur.text.trim() ? newMsg() : cur
        m.text = ''
        m.tools.push(ev.tool)
        if (ev.id) {
          toolsById.set(ev.id, ev.tool)
          // 输出比调用先到：补到刚建好的行上，并把这一行标成还在跑，界面才会边跑边跟着更新
          const early = earlyDeltas.get(ev.id)
          if (early !== undefined) {
            earlyDeltas.delete(ev.id)
            ev.tool.output = tail(early)
            ev.tool.running = true
          }
        }
        // 调用时就带着耗时的（完成后才报的）直接用；要等结果的从现在开始计时
        if (ev.tool.ms === undefined && (ev.id || ev.tool.running)) {
          ev.tool.startedAt = Date.now()
          toolStart.set(ev.tool, ev.tool.startedAt)
          // 补充还排着时又开始跑命令：同样要等它跑完才取，一起计时
          if (steerPending && !redirectTimer) checkRedirect()
        }
        if (ev.file) touched.add(ev.file.path.replaceAll('\\', '/'))
        if (ev.file) refreshChanges()
        if (ev.file && !ctx.isGit) {
          mergeChanges(task.changes, [ev.file])
          if (owner) mergeChanges((owner.changes ??= []), [ev.file])
        }
        break
      }
      case 'usage': {
        usageSeen = true
        const u = au()
        if (ev.model) u.model = ev.model
        if (ev.context !== undefined) {
          // 对话的会话里上下文骤降：CLI 自己压缩了却没报 compacted，同样作废已发的规则段落
          if (chat && compactedSilently(u.context, ev.context)) forgetPromptSent(task, sessionKey)
          u.context = ev.context
        }
        if (ev.window) {
          u.window = ev.window
          reported = true
        } else if (!reported) u.window = windowFor(u.model || model)
        if (compaction && ev.context !== undefined) {
          describeCompaction(compaction.tool, compaction.before, ev.context, u.window)
          compaction = undefined
        }
        u.outputTokens = (u.outputTokens ?? 0) + (ev.addOutput ?? 0)
        meter.real(ev.addOutput ?? 0)
        // 任务的累计和节点自己的都记一份，右栏点了节点时只看节点的
        for (const t of owner ? [task.usage, stepUsage(owner)] : [task.usage]) {
          t.inputTokens += ev.addInput ?? 0
          t.outputTokens += ev.addOutput ?? 0
          t.cacheReadTokens = (t.cacheReadTokens ?? 0) + (ev.addCacheRead ?? 0)
          t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + (ev.addCacheWrite ?? 0)
          t.costUsd += ev.addCost ?? 0
        }
        if (owner?.usage) Object.assign(owner.usage, { context: u.context, window: u.window, model: u.model })
        break
      }
      case 'context': {
        // CLI 自己报的上下文细分：会话栏优先按它分块（一轮结束后才到，单独推一次）
        au().snapshot = ev.snapshot
        ctx.changed()
        break
      }
      case 'tool_result': {
        // 工具的输出晚于调用到达，补到对应的那一行上
        const t = toolsById.get(ev.id)
        if (t) {
          if (ev.output) t.output = ev.output
          if (ev.failed) t.failed = true
          if (ev.exitCode !== undefined) t.exitCode = ev.exitCode
          if (ev.patch) t.input = ev.patch
          if (ev.detail !== undefined) t.detail = ev.detail
          delete t.running
          endTool(t)
        }
        break
      }
      case 'tool_delta': {
        const t = toolsById.get(ev.id)
        // 快照是到目前为止的全部输出（Pi 每次都给完整的一段），直接替换；其余是新增的一段，接在后面
        if (t) {
          t.output = ev.snapshot ? tail(ev.text) : tail((t.output ?? '') + ev.text)
          // 有输出在更新说明还在跑：CLI 的调用事件没带这个标记时也要让界面边跑边显示。
          // 已经有 ms 的是跑完的调用（迟到的增量），不能再标回运行中，否则会一直转圈
          if (t.output && t.ms === undefined) t.running = true
        } else {
          // 工具行还没建：先攒着（快照直接替换，增量接在后面），等 tool 事件到达时补上
          const prev = ev.snapshot ? '' : (earlyDeltas.get(ev.id) ?? '')
          earlyDeltas.set(ev.id, tail(prev + ev.text))
        }
        break
      }
      case 'files_changed':
        refreshChanges()
        return
      case 'turn':
        if (ev.id) turn.id = ev.id
        if (ev.end) turn.end = ev.end
        return
      case 'limits':
        setLimits(cliId, ev.limits)
        return
      case 'compacted': {
        // 压缩后会话里之前发过的规则只剩摘要：下一轮按完整提示重发（见 shared/prompt-delta.ts）
        forgetPromptSent(task, sessionKey)
        // 当作一次工具调用放进回复里，不插一条系统消息把回复切成两段；压缩后的大小晚一点从 usage 补上
        const u = au()
        const before = ev.before ?? (u.context || undefined)
        if (ev.context !== undefined) u.context = ev.context
        const tool: ToolUse = { kind: 'compact', name: t('压缩上下文'), label: '', detail: '' }
        compaction = { tool, before }
        describeCompaction(tool, before, ev.context, u.window)
        if (ev.context !== undefined) compaction = undefined
        const m = !cur || cur.text.trim() ? newMsg() : cur
        m.tools.push(tool)
        break
      }
      case 'todos':
        // 只替换这个 Agent 自己的清单，工作流里其他 Agent 的不动
        task.todos = [
          ...(task.todos ?? []).filter((x) => x.agentId !== agentId),
          ...ev.todos.map((x) => ({ ...x, agentId })),
        ]
        break
      case 'model':
        // 模型请求的耗时记在这段回复上：两步之间看起来「卡住」的时间大多在这里
        if (cur) cur.modelMs = (cur.modelMs ?? 0) + ev.ms
        break
      case 'error':
        errors.push(ev.message)
        break
      case 'notice': {
        // 重试、失败、面板工具没接上都要写进日志：界面上只留一行，事后统计「总是失败」要能查到是哪一类、第几次、恢复没有
        const sec = {
          task: task.id,
          step,
          cli: def.name,
          kind: ev.kind,
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          error: ev.error,
        }
        if (ev.failed) log.warn('agent', ev.text, sec)
        else if (ev.kind) log.info('agent', ev.text, sec)
        // 放进回复里当一行状态，不打断回复：例如「模型请求失败，2 秒后第 1 次重试」
        const m = !cur || cur.text.trim() ? newMsg() : cur
        // CLI 自己报的重试、失败：画成警告行，点开看是哪一类、怎么办
        const kind = !ev.failed && (ev.kind === 'retry' || /重试|retry/i.test(ev.text)) ? 'retry' : undefined
        m.tools.push({
          kind: 'other',
          name: t('提示'),
          label: ev.text,
          detail: '',
          ...(ev.failed ? { failed: true } : {}),
          ...(ev.failed || kind ? { alert: makeAlert(ev.failed ? 'error' : 'warn', ev.text, kind) } : {}),
        })
        break
      }
      case 'retry_ok': {
        // 重试成功不是提示：把前面那张「正在重试」收成已恢复，不再多插一行（没有卡片时什么都不加）
        log.info('agent', ev.text, { task: task.id, step, cli: def.name, kind: 'retry_ok', attempt: ev.attempt })
        settleRetryNotes(task.messages, ev.text, turnStart)
        break
      }
      case 'result':
        result = ev
        // 这一轮结束了：之后没有输出是在等下一句，不算卡住
        armedAt = 0
        // 留一条「为什么停」：排查「说了要做却没调工具就结束」时看是模型自己收尾（end_turn）还是被截断
        if (chat && !op)
          log.info('agent', `${def.name} 这一轮结束`, {
            task: task.id,
            step,
            ok: ev.ok,
            stopReason: ev.stopReason ?? '',
            tools: turnTools(),
            model,
          })
        // 一轮结束还没等到结果的调用（被打断、CLI 没报结果）：算到这里为止
        for (const x of [...toolStart.keys()]) endTool(x)
        // 一轮结束以 CLI 的 result 为准：进程还活着也可能已经回复完了
        if (chat && !op) {
          task.working = false
          // 什么都没收到的不算完成：这一轮要交给收尾处报错，不能先记成已完成
          if (ev.ok && !prewarmMode && !emptyTurn()) {
            endTurn()
          }
        }
        break
      case 'ask': {
        // 预热时用户还没发消息：不要让页面弹出确认/提问，直接拒绝并让它去等下一句
        if (prewarmMode) {
          ev.reply({ allow: false, message: '预热中，用户还没有发新消息；不要做别的，直接调用 wait_user_message。' })
          return
        }
        const id = ctx.newId()
        asked.push(id)
        replies.set(id, ev.reply)
        task.requests.push({
          id,
          step,
          agentId,
          kind: ev.kind,
          title: ev.title,
          detail: ev.detail,
          options: ev.options ?? [],
          ...(ev.questions ? { questions: ev.questions } : {}),
          at: new Date().toISOString(),
        })
        // 新的请求马上落盘，侧栏的铃铛和任务页立刻能看到
        ctx.changed(true)
        return
      }
    }
    ctx.changed()
  }
  const asked: string[] = []
  /** 补充：交给 CLI 成功后，之后的输出另起一条，排在用户消息后面 */
  let steerer: Steerer | undefined
  /** 延迟取走的补充：消息已经显示在对话里，CLI 开始下一次模型请求时再把后面的输出另起一条 */
  let steerPending = false
  /**
   * 插话收下时 Agent 正说到一半：CLI 让模型把这段话说完才看插话，面板也等这段说完再另起一条。
   * 收下就断开的话，后半句会跑到用户消息下面，一句话被劈成两半（用户报过）
   */
  let cutAfter = false
  let control: CliControl | undefined
  let redirectTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * 补充排在正在执行的命令后面（Pi 要等这一批工具跑完才取）：命令跑了一会儿还没完（例如 sleep 等 CI），
   * 用户就一直等不到回应。超过阈值就停下这条命令，让 CLI 马上处理补充；
   * 只读命令等它自己跑完（这批工具结束时 CLI 就会取补充），卡住了才按更长的阈值停
   */
  const checkRedirect = () => {
    clearTimeout(redirectTimer)
    redirectTimer = undefined
    const c = control
    if (!steerPending || finished || !c?.redirect) return
    // 只等命令：读文件、改文件很快就完；面板自己的工具（等子任务这些）另有办法接用户的消息
    const wait = redirectWait(
      [...toolStart].map(([x, at]) => ({ kind: x.kind, label: x.label, startedAt: at })),
      Date.now(),
      { command: REDIRECT_AFTER_MS, readOnly: REDIRECT_READONLY_AFTER_MS },
    )
    if (wait === undefined) return
    if (wait > 0) {
      redirectTimer = setTimeout(checkRedirect, wait)
      redirectTimer.unref?.()
      return
    }
    void c
      .redirect(REDIRECT_NOTE)
      .catch((e: Error) => log.warn('task', '停下命令处理补充失败', { task: task.id, error: e.message }))
  }
  const register = (c: CliControl) => {
    control = c
    steerer = {
      step,
      agentId,
      steer: c.steer,
      accepted: (msg) => {
        // CLI 收下了补充：这一轮又在处理了；延迟取走的那些等它真正开始下一次生成再断开输出
        if (msg) steered.add(msg)
        task.working = true
        // 交出的插话也要等到模型的回应：一直没有输出时照样标成卡住、告诉用户，不让「等待模型」无声地挂着
        arm(msg?.text)
        if (c.deferSteer) {
          steerPending = true
          checkRedirect()
        } else cutAfter = true
        ctx.changed(true)
      },
    }
    ;(steers.get(task.id) ?? steers.set(task.id, new Set()).get(task.id)!).add(steerer)
  }
  const idleMinutes = settings.idleTimeoutMinutes
  // 测试用：环境变量把「一分钟」缩短成几百毫秒，免得端到端测试真的等上几分钟
  const idleMs = idleMinutes * (Number(process.env.AGENT_PANEL_MINUTE_MS) || 60_000)
  // 对话的进程能不能留着等下一句（保活）：看 CLI 定义的 keepAlive 字段，不再借用 notes。
  // notes 只管「没有插话协议时怎么取补充」，两者混用会让 Pi 这种常驻协议的白白每轮重启
  const canWait = canKeepAlive({ chat, op: !!op, cliKeepAlive: def.keepAlive })
  // 用面板 MCP 工具取补充的，还得这个 CLI 能挂 MCP
  const canTake = chat && !op && def.notes && def.mcp && !def.rpc?.nativeAsk
  let taker: NoteTaker | undefined
  /** 登记了、CLI 还没取走的补充：消息已经在对话里，这一轮结束前没取走的交给下一轮接着处理 */
  const pendingNotes = new Set<TaskMessage>()
  /**
   * 以插话方式交出去的补充：CLI 收下不等于模型看见了。
   * 这一轮一个字都没产出时（网关吞了、请求根本没发出去），这些消息要交给下一轮重放，
   * 否则用户的消息只留在对话里，既没有回复也没有报错。
   */
  const steered = new Set<TaskMessage>()
  // notes 与 steer 不互斥：steer 在 CLI 不在活跃轮次时返回 false，补充会丢；两个通道都开（同样见 invoke.ts）
  if (canTake) {
    taker = {
      add: (msg) => pendingNotes.add(msg),
      read: () => {
        const mine = [...pendingNotes]
        if (!mine.length) return []
        pendingNotes.clear()
        // 拿到就算交出去了：之后的输出另起一条，排在用户消息后面
        cur = undefined
        ctx.changed(true)
        return mine.map((m) =>
          steerNote(withAttachments(m.text, m.attachments ?? []), task.mode === 'chat', m.peer?.rel === 'parent'),
        )
      },
    }
    addNoteTaker(task.id, taker)
  }
  // 对话页开着时，回复完停在面板的工具上等下一句：用户发消息直接交回这个进程，不用 --resume。
  // 有插话协议（Command Code、Pi）的对话也要这个工具，只是不用它取补充
  let waiter: Waiter | undefined
  /** 模型在这一轮里调用过 wait_user_message：结束时不用再保活一次 */
  let toolWaited = false
  /**
   * 等用户的下一条消息。fromTool 是模型正在调 wait_user_message（这一轮还没结束）；
   * 否则是面板在这一轮结束后保活：不靠模型自觉调工具，回复完就把进程留着
   */
  /** 停在等待上等子任务：CLI 本来就没有输出，不算卡住 */
  let waitingHelpers = false
  // 这一轮派出的子任务：对话停在面板的等待工具上等它们，等的时候用户照样能聊（见 helperGate）
  const gate =
    chat && orch
      ? helperGate(
          () => orch.helperBatch(),
          async (text) => {
            const s = steerer
            if (!s || !(await s.steer(text))) return false
            s.accepted()
            return true
          },
        )
      : undefined
  /**
   * 停下等下一句 / 等子任务：这段不用模型，让出 API 名额；拿到要处理的内容后先拿回名额再交给 CLI，
   * 满了就排队（对话上显示在等哪个 API），排队时停止就结束这一轮
   */
  /** 最近一次等到的是送进来的消息（用户 / 面板消息），不是子任务交回的结果 */
  let fromUser = false
  const waitNext = async (fromTool: boolean): Promise<string | null> => {
    const slot = apiSlots.get(slotKey(task.id, step))
    // 让出前手里有没有名额，决定拿回时是哪种排队：
    // 持有过 = 这一轮已经跑起来、临时让出（yield，不显示成排队）；
    // 没持有过 = 预热（prewarm）对话等第一句，这一轮从没出过 token，此刻排队就是真的还没开始（start）
    const yielded = !!slot?.holding
    slot?.drop()
    const text = await waitNextRaw(fromTool)
    if (text === null || !slot) return text
    return (await takeApiSlot(ctx, call.step, slot, ctx.signal, yielded ? 'yield' : 'start')) ? text : null
  }
  const waitNextRaw = async (fromTool: boolean): Promise<string | null> => {
    if (fromTool) {
      if (finished) return null
      toolWaited = true
    }
    // 这一轮派出的子任务还没交回：对话停在这里等它们做完，结果交回同一个进程接着做；
    // 等的时候用户发来的消息马上交给 CLI 回复，不用等子任务
    const back = gate?.wait(ctx.signal, (signal) => listen(signal, true))
    if (back) {
      const text = await back
      if (!text || ctx.signal.aborted) return null
      // 子任务的结果到了、接着干：从这一刻继续算执行
      resumeRun(task)
      // 交回的结果会让 CLI 接着做，这一段的结束要照常上报：result 之后停在这里等子任务时
      // 这一轮已经标记过结束了（见 endTurn），不复位会吞掉交回后那次结束
      turnEnded = false
      // 之后的输出另起一条，排在交回的结果后面
      cur = undefined
      task.working = true
      arm(text)
      ctx.changed(true)
      return text
    }
    // 用户在这一轮执行中换了 CLI/模型/强度：旧进程不要再等下一句，结束后按新的选择重开
    if (chat && !stillCurrent()) return null
    // 这一轮没取走的补充：不再挂着等下一句，直接结束这一轮，由调用方马上开始新一轮接着处理
    if (pendingNotes.size) return null
    return listen(ctx.signal, false)
  }
  /**
   * 停在等待上，等用户的下一条消息。helpers：其实在等子任务，这一轮没做完，
   * 不算回复完成，也不因为页面离开就结束（子任务的结果还要交回这个进程）
   */
  const listen = async (signal: AbortSignal, helpers: boolean): Promise<string | null> => {
    if (signal.aborted) return null
    task.prewarming = false
    // 等子任务时页面显示「等待 n 个子任务完成」，不是「等待你的下一条消息」
    if (helpers) waitingHelpers = true
    else {
      task.awaitingUser = true
      // 进保活前先让宿主按全局上限收一批最久没用的
      ctx.onKeepAlive?.(task.id)
    }
    // 停在等待上：这一段不算执行。等用户下一句时记进等待，等子任务时只结算执行时间
    //（等子对话的时间归到「子对话占用」，不能既算执行又算等待）。keepAlive 会让这次调用一直不返回
    if (!prewarmMode) pauseRun(task, Date.now(), { idle: !helpers })
    // CLI 回复完停在等下一句：这一轮已经结束，页面不再显示执行中
    task.working = false
    // 真正处理过用户消息的轮次才算完成；预热还没处理消息时不算
    if (!prewarmMode && chat && !op && !helpers) {
      endTurn()
    }
    ctx.changed(true)
    try {
      return await new Promise<string | null>((resolve) => {
        let settled = false
        const done = (value: string | null) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          const set = waiters.get(task.id)
          if (waiter) set?.delete(waiter)
          if (!set?.size) waiters.delete(task.id)
          waiter = undefined
          if (helpers) waitingHelpers = false
          task.awaitingUser = false
          task.prewarming = false
          if (value === null && chat && !helpers) task.working = false
          if (!finished) ctx.changed(true)
          resolve(value)
        }
        const onAbort = () => done(null)
        waiter = {
          deliver: (msg, placed, recorded) => {
            fromUser = true
            // 用户发来第一句：预热结束，之后模型的输出正常记进对话
            prewarmMode = false
            if (!recorded) task.messages.push(msg)
            // 继续执行：等待到此结束，从这一刻重新算执行时间
            resumeRun(task)
            // 收到用户消息，CLI 开始处理这一轮
            task.working = true
            // 之后的输出另起一条，排在用户消息后面
            cur = undefined
            const text = withAttachments(msg.text, placed ?? msg.attachments ?? [])
            // 新的一轮从这里算起：空回合判定只看这条消息之后的输出
            turnMark = { from: mine.length, touched: touched.size, input: text }
            turnEnded = false
            arm(text)
            done(text)
          },
          cancel: () => done(null),
          // 等子任务时没有换 CLI 的问题：消息照样交给这个进程
          current: helpers ? () => true : stillCurrent,
        }
        ;(waiters.get(task.id) ?? waiters.set(task.id, new Set()).get(task.id)!).add(waiter)
        signal.addEventListener('abort', onAbort, { once: true })
        // 页面已经离开（宽限过了）：不再一直挂着，让 CLI 结束这一轮（排着的消息由整次执行结束后接着处理）
        if (!isWatched(task.id)) done(null)
        // 这一轮结束前后到的、排着等下一轮的消息：停稳了马上交给它
        else if (!prewarmMode) flushHeld(task)
      })
    } finally {
      if (task.awaitingUser || task.prewarming) {
        task.awaitingUser = false
        task.prewarming = false
        if (!finished) ctx.changed(true)
      }
    }
  }
  // 模型主动调 wait_user_message 等下一句：这个工具是面板用 MCP 注进去的，只有能挂 MCP 的 CLI 才有
  const waitUser = canTake ? () => waitNext(true) : undefined
  // 面板保活：回复完这一轮不关进程，用户的下一条消息交给同一个进程开下一轮（不靠模型主动调等待工具）。
  // 只在对话页确实开着时这样做：没人看的时候留着一个 CLI 也没人会回来发消息
  const keepAlive = canWait
    ? async () => {
        if (!hasViewer(task.id)) return null
        // 这一轮什么都没收到：不保活，直接让它返回，交给收尾处报错
        if (emptyTurn()) return null
        fromUser = false
        const text = await waitNext(false)
        // 拿到下一句就是新一轮开始了：上一轮模型有没有等过，跟新一轮无关
        if (text !== null) toolWaited = false
        // 保活进程里的下一条消息：以前原样交给 CLI，计划状态、子对话发来的消息、授权变化都带不进去。
        // 交给调用方按当前状态补上变了的段落（见 shared/prompt-delta.ts）；子任务结果、/命令照旧原样
        if (text !== null && fromUser && call.nextPrompt && !text.trim().startsWith('/'))
          return await call.nextPrompt(text).catch(() => text)
        return text
      }
    : undefined

  if (!prewarmMode) arm()
  // 时长上限有两个来源：设置里的单步时限、计划带的时长上限。取小的那个，谁先到都停；
  // 停的时候要说清是哪个上限到的（见 effectiveTimeoutMinutes）
  const cap = effectiveTimeoutMinutes(settings.stepTimeoutMinutes, task.budgetMinutes ?? 0)
  // 模型对话（ADR 0025）：挂上 Blender 工具，新会话的提示词里说明怎么用；令牌只在这一轮有效
  const blender = task.modelDesign && def.mcp && !op ? openBlenderSession(task.id) : undefined
  if (blender && !resume) input = `${input}\n\n${MODEL_HINT}`
  const r = await invokeCli({
    mcp: blender ? [{ name: 'blender', url: blender.url }] : undefined,
    cliId,
    command: cs.command,
    build,
    cwd,
    env,
    input,
    // 进程面板按这个归属：子对话、子任务、工作流都是同一个任务树上的进程
    owner: { taskId: task.id, rootTaskId: task.rootTaskId || task.id, title: task.title },
    signal: ctx.signal,
    // 0 表示不限制
    timeoutMs: cap.minutes ? cap.minutes * 60_000 : 0,
    // 环境性失败重试那一轮把请求超时放宽：高负载时 CLI 冷启动 + 桥接扩展加载会顶到默认的 15 秒
    requestTimeoutMs: envStalls ? envStallTimeout(cliId) : undefined,
    idle: idleMs
      ? {
          ms: idleMs,
          // 在等用户确认、回答或下一句时 CLI 本来就没有输出，不算卡住
          // 排队等 API 名额时也一样
          busy: () =>
            task.awaitingUser ||
            waitingHelpers ||
            !!(call.step ? call.step.apiWait : task.apiWait) ||
            task.requests.some((x) => asked.includes(x.id)),
          onWarn: () => {
            task.messages.push({
              id: ctx.newId(),
              role: 'system',
              agentId,
              step,
              text: t(
                '{cli} 已经 {n} 分钟没有任何输出，可能卡在登录、网络重连或交互式确认上。再过 {n} 分钟还没有输出会自动停止；也可以现在停止后检查一下。',
                { cli: def.name, n: idleMinutes },
              ),
              tools: [],
              alert: makeAlert('warn', t('最后一次输出在 {n} 分钟前', { n: idleMinutes }), 'idle'),
              at: new Date().toISOString(),
            })
            ctx.changed(true)
          },
        }
      : undefined,
    onEvent: apply,
    // 会话栏的上下文细分：记下面板交给这个会话的工具和系统提示词（压缩、审查这类操作只挂提问工具，不记）
    onTools: op
      ? undefined
      : (tools, deferred) => {
          au().parts = {
            cli: cliId,
            system: def.systemPromptFlag ? instructions.length : 0,
            tools,
            deferred,
          }
          ctx.changed()
        },
    // 任务上的「提问」开关：执行中也能改，CLI 问的时候再看
    askUser: () => task.askUser,
    // 对话、工作流节点和工作流跑完后的追加要求都能接收补充；压缩、审查这类操作不接收
    onControl: chat || (!op && (step || task.mode === 'workflow')) ? (c) => register(c) : undefined,
    readNotes: taker ? () => taker.read() : undefined,
    waitUser,
    // 回复完把进程留着等下一句：对话页开着时不靠模型主动调 wait_user_message
    keepAlive,
    // 模型自己等过下一句的，结束时不再保活一次
    waited: () => toolWaited,
    orch,
    // 操控软件的动作：对话（父对话、子对话）才给，派出的子任务是一次性的小活，不该操控软件（见 ADR 0011）
    app:
      orch && !orch.helper
        ? { taskId: task.id, projectId: task.projectId, parentTaskId: task.parentTaskId ?? '' }
        : undefined,
    // 只交手动改过的：自动值是面板按模型目录估的，不该写进 CLI 的配置盖掉它自己的
    limits: manual,
  }).finally(() => {
    finished = true
    blender?.close()
    clearInterval(stallTimer)
    stalled.delete(task.id)
    clearTimeout(redirectTimer)
    for (const x of [...toolStart.keys()]) endTool(x)
    // CLI 一直没报告开始下一次模型请求：补充也算交给了它，输出直接另起一条
    if (steerPending) {
      steerPending = false
      cur = undefined
    }
    // 进程先结束了（崩溃、被停掉）：还在等下一句的那次请求也结束，别一直挂着
    cancelWait(task.id)
    // 留给「下一个节点」的补充：后面还有节点会取走时就留着，没有了就清掉。
    // 不按任务清是因为当前这个节点结束时，下一个节点还没来得及启动
    const nextStep =
      task.mode === 'workflow' &&
      task.steps.some((s) => s.id !== step && s.status !== 'done' && s.status !== 'failed' && s.status !== 'skipped')
    if (!nextStep) notes.delete(task.id)
    clearTimeout(gitTimer)
    if (steerer) {
      const set = steers.get(task.id)
      set?.delete(steerer)
      if (!set?.size) steers.delete(task.id)
    }
    if (taker) {
      removeNoteTaker(task.id, taker)
      // 这一轮里没取走的补充：消息已经在对话里，记下来让这一轮结束后马上接着处理
      for (const m of pendingNotes) holdForNextTurn(task.id, m)
      pendingNotes.clear()
    }
    // 插话交出去、这一轮却一个字都没产出的：CLI 收下不等于模型看见，交回下一轮重放。
    // texts 要等进程结束后才汇总，这里看 mine 里已经收到的正文
    if (!turnMsgs().some((m) => m.role === 'agent' && m.text.trim()))
      for (const m of steered) holdForNextTurn(task.id, m)
    steered.clear()
    meter.stop()
    // 进程结束了（完成、停止、超时），还没回答的请求作废
    for (const id of asked) replies.delete(id)
    task.requests = task.requests.filter((x) => !asked.includes(x.id))
    if (task.usage.agents[agentId]) task.usage.agents[agentId].tps = 0
  })

  for (const m of mine) if (m.text && m.role === 'agent') texts.push(m.text)
  // 空回合兜底只看最后一轮：保活时前几轮的回复不能把最后一条没人答的消息盖住
  const turnTexts = turnMsgs().flatMap((m) => (m.text && m.role === 'agent' ? [m.text] : []))
  // 记下这一轮在会话里的位置，分叉、撤回时让 CLI 从这里截断
  if (asker && task.sessions[sessionKey])
    asker.turn = { session: task.sessions[sessionKey], id: turn.id, end: turn.end }
  if (ctx.isGit) {
    const changes = await gitChanges(cwd, task.baseline, task.baseRef, placedFiles(task)).catch(() => null)
    if (changes) {
      // 只在跑的节点的改动也会出现在差值里：只算 CLI 亲自报告的文件改动（Write、Edit 报的 file 事件）。
      // 没报告过文件的节点（只读调研、用命令写的）不加归因：差值里可能是并行子对话的改动，算给它就变成了它的改动
      const mine = ownedChanges(changesSince(before, changes), touched)
      if (owner) mergeChanges((owner.changes ??= []), mine)
      task.changes = changes
    }
  }
  ctx.changed(true)

  // 进程结束的情况都记一笔：退出码、为什么被停、最后的错误输出，排查问题时对得上页面上的报错
  if (r.killed || r.spawnError || r.code !== 0 || result?.ok === false)
    log.warn('agent', `${def.name} 进程结束`, {
      task: task.id,
      step,
      code: r.code,
      killed: r.killed,
      spawnError: r.spawnError,
      result: result?.error,
      errors: errors.join('\n'),
      stderr: r.stderr.trim().split('\n').slice(-20).join('\n'),
    })
  // CLI 根本没起来（可执行文件找不到、node_modules 被清空、路径不对）：这是失败，不是停止。
  // 必须排在 abort 判定前面：进程起不来时面板也可能同时收到过停止信号，
  // 那时写成 stopped 就会显示成「已暂停」，用户还以为自己按了暂停
  if (r.spawnError)
    return {
      ok: false,
      error: t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写可执行文件的完整路径。', {
        error: r.spawnError,
        cli: def.name,
        hint: def.installHint,
      }),
    }
  // 停止时 CLI 自己中断了这一轮（进程正常退出），也算停止
  if (r.killed === 'stopped' || (ctx.signal.aborted && !r.killed))
    return { ok: false, stopped: true, error: t('已停止') }
  if (r.killed === 'timeout')
    return cap.by === 'budget'
      ? {
          ok: false,
          stopped: true,
          budget: true,
          error: t('这次执行超过计划设定的 {n} 分钟上限，已停止。已经产出的内容都保留着，点「继续执行」会重新计时。', {
            n: cap.minutes,
          }),
        }
      : { ok: false, error: t('超过 {n} 分钟没有完成，已停止', { n: cap.minutes }) }
  if (r.killed === 'idle') {
    const detail = [...errors, r.stderr.trim().split('\n').slice(-6).join('\n')].filter(Boolean).join('\n')
    return {
      ok: false,
      error: [
        t('{cli} 连续 {n} 分钟没有任何输出，已停止。', { cli: def.name, n: idleMinutes * 2 }),
        ...failureHints(detail, def),
        detail ? `\n${t('最后的输出：')}\n${clip(detail, 1500)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  const failed = result ? !result.ok : r.code !== 0
  if (failed) {
    const detail = [result?.error, ...errors, r.stderr.trim().split('\n').slice(-6).join('\n')]
      .filter(Boolean)
      .join('\n')
    // 自定义接口的模型不支持调整思考强度：记住，去掉强度再跑一次（CLI 启动时就退出，没有实际输出）
    if (effort && !retried && EFFORT_REJECTED.test(detail)) {
      markNoEffort(cliId, model)
      log.warn('agent', `${def.name} 的模型 ${model} 不支持设置思考强度，去掉后重试`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      return runAgent(
        ctx,
        call,
        true,
        // 换参数重跑：续接记录保持默认（这次没有），环境性重试的计数和留痕要接着传
        undefined,
        undefined,
        undefined,
        undefined,
        envStalls,
        envStallNotes,
      )
    }
    // 会话找不到时（例如 CLI 清理了历史），丢掉会话重新开始一次
    if (
      resume &&
      !prewarm &&
      !retried &&
      /(no|not).{0,40}(session|conversation|thread)|(session|conversation|thread).{0,40}not found/i.test(detail)
    ) {
      delete task.sessions[sessionKey]
      delete task.sessionDirs[sessionKey]
      // 新会话没有之前的上下文，要用完整提示
      return runAgent(
        ctx,
        { ...call, prompt: call.fresh ?? call.prompt },
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        envStalls,
        envStallNotes,
      )
    }
    // 会话存在别的项目目录里，CLI 要交互确认分叉才继续（Pi 的「Session found in different project」）：
    // 非交互模式拿不到回答，CLI 直接按 Aborted 退出。旧任务没记会话目录时只能碰运气，撞上了就丢掉会话重开一次
    if (resume && !prewarm && !retried && SESSION_OTHER_PROJECT.test(detail)) {
      delete task.sessions[sessionKey]
      delete task.sessionDirs[sessionKey]
      log.warn('agent', `${def.name} 的会话在别的目录里，丢掉后重开`, {
        task: task.id,
        step,
        cwd,
        detail: detail.slice(0, 500),
      })
      return runAgent(
        ctx,
        { ...call, prompt: call.fresh ?? call.prompt },
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        envStalls,
        envStallNotes,
      )
    }
    // 接口拒绝了这条会话的历史（换过模型、网关换了上游，或历史里的内容片段丢了）：
    // 之后每次请求都会失败，丢掉会话重开一次；对话把之前的记录带上，节点用完整提示
    if (
      resume &&
      !prewarm &&
      !op &&
      !retried &&
      (/input\.content/i.test(detail) || /text part\b[^\n]*\bnot found/i.test(detail))
    ) {
      delete task.sessions[sessionKey]
      delete task.sessionDirs[sessionKey]
      const carry = chat
        ? `## 之前的对话\n${transcript(task, asker ? task.messages.indexOf(asker) : task.messages.length)}`
        : ''
      log.warn('agent', `${def.name} 的会话和当前模型不兼容，丢掉旧会话重开`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      return runAgent(
        ctx,
        chat ? call : { ...call, prompt: call.fresh ?? call.prompt },
        true,
        netRetries,
        carry,
        undefined,
        undefined,
        envStalls,
        envStallNotes,
      )
    }
    const hints = failureHints(detail, def)
    const head =
      r.code !== null && r.code !== 0
        ? t('{cli} 执行失败（退出码 {code}）：', { cli: def.name, code: r.code })
        : t('{cli} 执行失败：', { cli: def.name })
    const raw = clip(detail || t('没有更多信息'), 1500)
    const message = [head, ...hints, hints.length ? `\n${t('原始输出：')}\n${raw}` : raw].join('\n')
    // 环境性卡住（请求超时，但进程还活着、一个字都没输出）：面板这边没等够，不是用户的要求有问题。
    // 先把这件事写进对话，放宽这一轮的等待再跑一次（只一次，不能循环）；
    // 这时旧进程已经结束（invokeCli 返回前它就退出了），不会留着孤儿进程
    const budget = envStallBudget(cliId)
    if (
      shouldRetryEnvStall({
        stall: !!result?.envStall,
        retries: envStalls,
        aborted: ctx.signal.aborted,
        prewarm,
        budget,
      })
    ) {
      const timeoutMs = envStallTimeout(cliId)
      const note: TaskMessage = {
        id: ctx.newId(),
        role: 'system',
        agentId,
        step,
        text: [message, '', envStallNote(timeoutMs)].join('\n'),
        tools: [],
        error: true,
        alert: makeAlert('warn', raw, 'no_response'),
        at: new Date().toISOString(),
      }
      task.messages.push(note)
      log.warn('agent', `${def.name} 没有响应（进程还活着、没有输出），放宽等待自动重试一次`, {
        task: task.id,
        step,
        timeoutMs,
      })
      ctx.changed(true)
      return runAgent(ctx, call, retried, netRetries, retryCarry, netNotes, contextNotes, envStalls + 1, [
        ...envStallNotes,
        { msg: note, base: message },
      ])
    }
    // 连接中途断开（多半是输出很长时被服务端或代理断开）：有会话就续接让它接着做，最多两次。
    // 每次断开都把完整报错写进节点里再续接，不能悄悄重试，否则页面上只看到 Agent 反复说同一句话
    const session = task.sessions[sessionKey]
    if (isNetError(detail) && session && !prewarm && netRetries < MAX_NET_RETRIES && !ctx.signal.aborted) {
      const note: TaskMessage = {
        id: ctx.newId(),
        role: 'system',
        agentId,
        step,
        text: [
          message,
          '',
          t('正在自动续接会话重试（第 {n}/{max} 次）…', { n: netRetries + 1, max: MAX_NET_RETRIES }),
        ].join('\n'),
        tools: [],
        error: true,
        alert: makeAlert('warn', raw, 'network'),
        at: new Date().toISOString(),
      }
      task.messages.push(note)
      netNotes = [...netNotes, { msg: note, base: message, n: netRetries + 1 }]
      log.warn('agent', `${def.name} 连接中断，自动续接第 ${netRetries + 1} 次`, { task: task.id, step, detail })
      ctx.changed(true)
      return runAgent(
        ctx,
        {
          ...call,
          prompt:
            '刚才和模型服务的连接中断了，请从中断的地方继续完成之前的任务，已经做完的不用重做。' +
            '如果是在一次写入很长的文件时断开的，请分几次写：先写前一部分，再分段追加，每次不要太长。',
        },
        retried,
        netRetries + 1,
        '',
        netNotes,
        contextNotes,
        envStalls,
        envStallNotes,
      )
    }
    // 上下文已经超过模型上限：同一段历史再发一次只会一样被拒，压缩也一样（它要把历史整段重发）。
    // 唯一能做的自救是丢掉会话、把对话裁剪到预算内换成新会话接着做；只降一次（retried）
    const fallback = contextFallbackKind({
      detail,
      retried,
      prewarm,
      aborted: ctx.signal.aborted,
      compact: op?.kind === 'compact',
      chatResume: Boolean(chat && resume),
    })
    if (fallback) {
      // 压缩：不再请求模型（它照样会拒），把裁剪后的记录当作摘要写进 rewind，按压缩成功返回，下一轮开新会话带上
      if (fallback === 'compact') {
        const summary = [
          t('（原始对话已经超过模型上限，连压缩请求也被拒绝，以下是面板裁剪后保留的记录）'),
          clippedTranscript(task, task.messages.length, carryBudget()),
        ].join('\n\n')
        task.rewind = { session: '', through: null, latest: false, summary }
        delete task.sessions[sessionKey]
        delete task.sessionDirs[sessionKey]
        au().context = 0
        task.messages.push({
          id: ctx.newId(),
          role: 'system',
          agentId,
          step,
          text: t('已压缩上下文：对话本身太长，模型连压缩请求都拒绝了，已改为裁剪后开新会话带上（保留最近的内容）'),
          tools: [],
          at: new Date().toISOString(),
        })
        ctx.changed(true)
        log.warn('agent', `${def.name} 压缩上下文时仍然超过上限，改用裁剪后的记录开新会话`, {
          task: task.id,
          step,
          detail: detail.slice(0, 500),
        })
        return { ok: true, text: summary }
      }
      // 普通一轮：丢掉会话，把对话裁剪后交给新会话（复用 retryCarry 的续接路径）
      if (fallback === 'restart') {
        delete task.sessions[sessionKey]
        delete task.sessionDirs[sessionKey]
        const upto = asker ? task.messages.indexOf(asker) : task.messages.length
        const carry = `## 之前的对话（已按长度裁剪）\n${clippedTranscript(task, upto, carryBudget())}`
        const note: TaskMessage = {
          id: ctx.newId(),
          role: 'system',
          agentId,
          step,
          text: [
            message,
            '',
            t('这次请求的上下文已经超过 {cli} 的上限。正在丢掉旧会话，把对话裁剪后开新会话接着做…', { cli: def.name }),
          ].join('\n'),
          tools: [],
          error: true,
          alert: makeAlert('warn', raw, 'context'),
          at: new Date().toISOString(),
        }
        task.messages.push(note)
        log.warn('agent', `${def.name} 的上下文超过上限，丢掉旧会话并裁剪后重开`, {
          task: task.id,
          step,
          detail: detail.slice(0, 500),
        })
        ctx.changed(true)
        return runAgent(
          ctx,
          call,
          true,
          netRetries,
          carry,
          netNotes,
          [...contextNotes, { msg: note, base: message }],
          envStalls,
          envStallNotes,
        )
      }
    }
    log.error('agent', `${def.name} 执行失败`, { task: task.id, step, code: r.code, detail })
    // 两次都没等到响应：失败卡片里写明面板已经重试过一次，不让用户以为是第一次就失败
    const tried = [
      netRetries ? t('已自动续接 {n} 次，仍然失败。', { n: netRetries }) : '',
      envStalls ? envStallFailure(envStalls) : '',
    ].filter(Boolean)
    return { ok: false, error: tried.length ? [message, '', ...tried].join('\n') : message }
  }
  // 这一轮 CLI 报了结束，却什么都没收到（没有正文、没调工具、没改文件）：CLI 或网关出了问题。
  // 按「错误一律显示」写进对话，这一轮按失败结束；不自动重试，由用户决定重发、继续还是换模型。
  // 不限定对话：子 Agent（工作流节点、并行子任务）同样可能空着收尾，那一路要让失败报回派它的一方。
  if (
    !op &&
    !prewarm &&
    !ctx.signal.aborted &&
    silentTurn({ texts: turnTexts, tools: turnTools(), changed: touched.size - turnMark.touched })
  ) {
    const what = t('这一轮 {cli} 没有返回任何内容，这条要求没有被处理', { cli: def.name })
    task.messages.push({
      id: ctx.newId(),
      role: 'system',
      agentId,
      step,
      text: what,
      tools: [],
      error: true,
      alert: makeAlert('error', what, 'empty_turn'),
      at: new Date().toISOString(),
    })
    ctx.changed(true)
    log.error('agent', `${def.name} 没有返回任何内容`, { task: task.id, step })
    return { ok: false, error: what }
  }
  log.info('agent', `${def.name} 完成`, { task: task.id, step })
  // 续接成功了：之前那次断开的报错已经不成立，收成普通说明（否则对话里一直留着一张红色「执行失败」卡片）
  settleNetNotes(netNotes)
  // 上下文超长降级：裁剪后的新会话接上了，那张失败卡片同样要收掉
  settleContextNotes(contextNotes)
  // 环境性失败重试成功：那一轮其实做成了，同样收成普通说明
  settleEnvStallNotes(envStallNotes)
  if (netNotes.length || contextNotes.length || envStallNotes.length) ctx.changed(true)
  const done: AgentResult = { ok: true, text: texts.join('\n\n') }
  // 赋成 undefined 而不是 delete：保存时和旧记录合并，delete 掉的字段会被旧值补回来
  if (rewind) task.rewind = undefined
  const sysMsg = (text: string, error?: boolean, alert?: Alert) => {
    task.messages.push({
      id: ctx.newId(),
      role: 'system',
      agentId,
      step,
      text,
      tools: [],
      ...(error ? { error } : {}),
      ...(alert || error ? { alert: alert ?? makeAlert('error', text) } : {}),
      at: new Date().toISOString(),
    })
    ctx.changed(true)
  }
  // 这一轮调了模型、却一条用量事件都没收到（网关不回 usage）：统计会是 0，别让 0 被当成「没消耗」。
  // 正文和报错都为空时同样要说明：那一轮很可能连模型请求都没发出去，只留一行 0 的统计会看不出问题
  if (chat && !op && !prewarm && !usageSeen)
    sysMsg(
      texts.length || errors.length
        ? t('这次没有拿到 {cli} 报告的用量，下面的 token 和费用统计不可信（不代表没有消耗）。', { cli: def.name })
        : t('这次没有拿到 {cli} 的任何输出和用量：这条要求很可能没有被处理，可以重发或换一个模型再试。', {
            cli: def.name,
          }),
      false,
      texts.length || errors.length ? undefined : makeAlert('warn', errors.join('\n'), 'empty_turn'),
    )
  // 压缩过（原生压缩不一定报 compacted 事件）：会话里之前发过的规则段落不算数了
  if (op?.kind === 'compact') forgetPromptSent(task, sessionKey)
  // 不能压缩会话的 CLI：摘要写好了，下一轮开新会话带上它
  if (op?.kind === 'compact' && def.compact === 'summary') {
    task.rewind = { session: '', through: null, latest: false, summary: done.text }
    delete task.sessions[sessionKey]
    delete task.sessionDirs[sessionKey]
    au().context = 0
    sysMsg(t('已压缩上下文：下一轮会开新的会话，带上这份摘要'))
  }
  // 达到设置的上下文占用时自动压缩（Claude Code 和 Codex 由 CLI 自己按设置压缩）
  const u = task.usage.agents[agentId]
  if (
    chat &&
    !op &&
    !prewarm &&
    pct &&
    def.autoCompact === 'panel' &&
    u?.window &&
    (u.context / u.window) * 100 >= pct
  ) {
    sysMsg(t('上下文占用达到 {n}%，自动压缩', { n: Math.round((u.context / u.window) * 100) }))
    // 压缩也是这一轮里的一次完整调用：环境性重试的计数和留痕要接着传，否则重置后可能再重试一次
    const c = await runAgent(
      ctx,
      { ...call, op: { kind: 'compact' } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envStalls,
      envStallNotes,
    )
    if (!c.ok && !c.stopped) sysMsg(t('自动压缩失败：{error}', { error: c.error }), true, makeAlert('error', c.error))
  }
  return done
}

/**
 * 子对话的独立分支一律不推到远端（推送只由父对话在原分支上做），项目设置成「不推送」时整个项目都不推：
 * 提示词拦不住所有模型，用 git 的 pushInsteadOf 把所有远端地址的推送改写到一个不存在的协议，
 * CLI 里跑的 git push 都会失败，拉取不受影响
 */
export function noPushEnv(task: Task, gitPolicy?: Project['gitPolicy']): { key: string; value: string }[] {
  if (gitPolicy !== 'deny' && (!task.parentTaskId || task.worktree?.state !== 'active')) return []
  return [
    { key: 'GIT_CONFIG_COUNT', value: '1' },
    { key: 'GIT_CONFIG_KEY_0', value: 'url.agent-panel-no-push://.pushInsteadOf' },
    { key: 'GIT_CONFIG_VALUE_0', value: '' },
  ]
}

/**
 * 搜索排除交给 rg 自己执行：大项目（尤其 P4 这种没有 .gitignore 的）只靠提示词时，
 * CLI 内置搜索照样扫进 Intermediate、Saved 这些产物目录，一次搜几分钟。
 * 写一份 ripgrep 配置、用 RIPGREP_CONFIG_PATH 指过去；用户本来设了的，把原来的内容放在前面一起带上
 */
async function searchExcludeEnv(ctx: RealContext): Promise<{ key: string; value: string }[]> {
  const lines = searchExcludeRgConfig(ctx.project, { onlyProject: ctx.isGit })
  if (!lines.length) return []
  const own = process.env.RIPGREP_CONFIG_PATH
  const prev = own ? await readFile(own, 'utf8').catch(() => '') : ''
  const body = [prev.trimEnd(), ...lines].filter(Boolean).join('\n') + '\n'
  // 按内容起名、已有就不再写：并行的几个 Agent 同时启动时，rg 不会读到写了一半的文件
  const file = path.join(CACHE_DIR, 'rg', `${createHash('sha1').update(body).digest('hex').slice(0, 16)}.rc`)
  try {
    if (!existsSync(file)) {
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, body)
      await rename(tmp, file)
    }
  } catch (e) {
    log.warn('agent', '写搜索排除配置失败', e)
    return []
  }
  return [{ key: 'RIPGREP_CONFIG_PATH', value: file }]
}

/**
 * 这次执行里能用的授权：项目设置的推送策略、这个对话里用户已经做过的选择、
 * 本机已经装好并登录的外部工具（gh、cloudflared 等）。列进提示词，模型不用重新探测
 */
async function taskPolicy(ctx: RealContext): Promise<EngineHost['policy']> {
  const views = await listIntegrations().catch(() => [])
  return {
    push: ctx.project.gitPolicy ?? 'ask',
    answered: ctx.task.remotePush,
    tools: views.filter((v) => v.installed && v.authed).map((v) => v.name),
  }
}

/** 真实执行一轮：调度交给执行引擎，调用 Agent 时启动对应 CLI */
export async function runRealTurn(ctx: RealContext) {
  ctx.task.simulated = false
  // ADR 0020：这一轮的计划提醒（滞后 / 新输入没跟着改）由 engine 的 planPart 写进提示词；
  // 服务端在这里留一条日志，方便事后确认「到底提醒过没有」。新输入的提醒只算一次：
  // 这一轮结束后记下「提醒过这次输入」，同一个要求不会每轮重复追问（对话选择「不改计划、说明一句」时尤其需要）
  const plan = activePlan(ctx.task)
  const unhandled = plan ? inputUnhandled(plan) : undefined
  // 本轮提醒的是「这一次输入」：轮中随时可能又来新消息（deliver 会更新 lastInputAt），
  // 轮末不能再读 lastInputAt，否则会把没提醒过的那次也标成已提醒（评审 R2）
  const noticedInput = unhandled !== undefined ? plan?.lastInputAt : undefined
  const notice = planNotice(ctx.task)
  if (notice) log.warn('plan', '计划需要对话收口，已写进这一轮的提示词', { task: ctx.task.id, notice })
  await runEngineTurn({
    task: ctx.task,
    agents: ctx.agents,
    workflows: ctx.workflows,
    workflow: ctx.workflow,
    prompt: ctx.prompt,
    policy: await taskPolicy(ctx),
    resume: ctx.resume,
    prewarm: ctx.prewarm,
    prewarmFrom: ctx.prewarmFrom,
    prewarmTurnDoneAt: ctx.prewarmTurnDoneAt,
    changed: ctx.changed,
    newId: ctx.newId,
    // 项目设置优先、没设时跟随全局：默认 UTF-8 无 BOM + LF
    fileFormat: projectFormat(ctx.project, ctx.settings),
    // 项目设置里的搜索排除清单（项目填的 + 内置默认），写进提示词的搜索段
    searchExclude: searchExcludeOf(ctx.project),
    searchInGit: ctx.isGit,
    workflowCatalog: ctx.workflowCatalog,
    resolveWorkflow: ctx.resolveWorkflow,
    listConversations: ctx.listConversations,
    createConversation: ctx.createConversation,
    sendToConversation: ctx.sendToConversation,
    rules: ctx.rules,
    goal: ctx.goal,
    takeInbox: ctx.takeInbox,
    messageParent: ctx.messageParent,
    claimFiles: ctx.claimFiles,
    releaseFiles: ctx.releaseFiles,
    childIsolation: ctx.childIsolation,
    worktreeHome: ctx.worktreeHome,
    branch: ctx.branch,
    wrapUp: ctx.wrapUp,
    p4Split: ctx.p4Split,
    submitMerge: ctx.submitMerge,
    finishChild: ctx.finishChild,
    ueBuild: ctx.ueBuild,
    peers: ctx.peers,
    messagePeer: ctx.messagePeer,
    verify: ctx.verify,
    beginEdit: ctx.beginEdit,
    inlineEdit: ctx.inlineEdit,
    runBackground: ctx.runBackground,
    checkBackground: ctx.checkBackground,
    stopBackground: ctx.stopBackground,
    forwardSpawn: ctx.forwardSpawn,
    onOrchestra: ctx.onOrchestra,
    lessons: ctx.lessons,
    runAgent: (call) => gatedRunAgent(ctx, ctx.op && !call.step ? { ...call, op: ctx.op } : call),
    yieldSlot: (stepId, wait) => yieldApiSlot(ctx, stepId, wait),
    signal: ctx.signal,
    stopReason: ctx.stopReason,
    // 对话等子任务时用户发来的消息：马上开一轮回复
    waitChat: ctx.task.mode === 'chat' ? (signal) => waitChat(ctx.task, signal, ctx.changed) : undefined,
    // 编排工具的传话：交给正在跑的那个节点（CLI 支持执行中补充时），交不了由引擎放进它的收件箱
    steer: async (stepId, text) => {
      for (const s of steers.get(ctx.task.id) ?? [])
        if (s.step === stepId && (await s.steer(text))) {
          s.accepted()
          return true
        }
      return false
    },
    confirm: (step, text) =>
      new Promise((resolve) => {
        const { task, signal } = ctx
        if (signal.aborted) return resolve(null)
        const id = ctx.newId()
        const done = (r: { allow: boolean; answer?: string } | null) => {
          signal.removeEventListener('abort', onAbort)
          replies.delete(id)
          task.requests = task.requests.filter((x) => x.id !== id)
          resolve(r)
        }
        // 停止任务时不再等，节点停在这里，继续执行时重新确认
        const onAbort = () => {
          done(null)
          ctx.changed(true)
        }
        signal.addEventListener('abort', onAbort)
        replies.set(id, (r) => done(r))
        task.requests.push({
          id,
          step: step.id,
          agentId: step.agentId,
          kind: 'confirm',
          title: t('「{title}」完成了，看一下结果再继续', { title: step.title }),
          detail: clip(text, 6000),
          options: [],
          at: new Date().toISOString(),
        })
        ctx.changed(true)
      }),
    reviewDiff: ctx.isGit
      ? async (since, files) => {
          // 没点名文件时只取这个对话改过的（和「更改」面板一致）：对话开始前就没提交的改动不算它的，不交给评审
          const own =
            files ??
            (since
              ? undefined
              : (
                  await gitChanges(ctx.project.path, ctx.task.baseline, ctx.task.baseRef, placedFiles(ctx.task)).catch(
                    () => null,
                  )
                )?.map((c) => c.path))
          const d = await reviewDiff(ctx.project.path, ctx.task.baseRef, since, own, placedFiles(ctx.task))
          if (!d) return null
          if (d.diff || !d.full) return { snapshot: d.snapshot, stat: d.stat, diff: d.diff }
          // 太长：完整差异存进交接目录，提示词里只给文件列表和路径
          const dir = path.join(HANDOFF_DIR, ctx.task.id)
          await mkdir(dir, { recursive: true })
          const file = path.join(dir, `review-${d.snapshot.slice(0, 12)}.diff`)
          await writeFile(file, d.full)
          return { snapshot: d.snapshot, stat: d.stat, diff: '', file }
        }
      : undefined,
    saveHandoff: async (step, text) => {
      const dir = path.join(HANDOFF_DIR, ctx.task.id)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `${step.id}.md`)
      await writeFile(file, `# ${step.title}\n\n${text}\n`)
      return file
    },
  })
  if (noticedInput && plan) {
    plan.inputNotedAt = noticedInput
    ctx.changed()
  }
}

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

/** 压缩上下文的工具调用：一行写压缩了多少，右边写现在占上下文窗口多少，点开看明细 */
export function describeCompaction(tool: ToolUse, before?: number, after?: number, window?: number) {
  // 前后大小单独存一份结构化字段：界面要显示「压缩前 / 压缩后」，不解析下面的中文 label
  if (before !== undefined || after !== undefined) tool.compact = { before, after }
  const pct = after !== undefined && window ? Math.round((after / window) * 100) : undefined
  tool.label =
    before !== undefined && after !== undefined
      ? t('压缩了 {freed} token（{before} → {after}）', {
          freed: fmtTok(Math.max(0, before - after)),
          before: fmtTok(before),
          after: fmtTok(after),
        })
      : before !== undefined
        ? t('压缩前 {before} token', { before: fmtTok(before) })
        : t('已压缩上下文')
  tool.detail = pct !== undefined ? t('当前占用 {pct}%', { pct }) : ''
  tool.output = [
    before !== undefined && t('压缩前：{n} token', { n: fmtTok(before) }),
    after !== undefined && t('压缩后：{n} token', { n: fmtTok(after) }),
    window && t('上下文窗口：{n} token', { n: fmtTok(window) }),
    pct !== undefined && t('当前占用：{pct}%', { pct }),
  ]
    .filter(Boolean)
    .join('\n')
}
