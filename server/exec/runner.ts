import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  defaultAgent,
  type Agent,
  type AgentUsage,
  type CliStatus,
  type Project,
  type Settings,
  type Task,
  type TaskMessage,
  type ToolUse,
  type Workflow,
} from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { addNoteTaker, holdForNextTurn, noteTakersOf, removeNoteTaker, type NoteTaker } from './delivery.ts'
import { agentPermission, agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import {
  changesSince,
  mergeChanges,
  pauseRun,
  questionAnswers,
  resumeRun,
  sessionChanged,
  stepUsage,
  withAttachments,
  withTaskModel,
} from '../../shared/task.ts'
import { UPLOADS_DIR } from '../uploads.ts'
import { HANDOFF_DIR } from '../store.ts'
import { expandSlash } from '../slash.ts'
import { cachedModels, knownWindows, markNoEffort, supportedEffort } from '../models.ts'
import { autoLimits, limitEnvVars, type ModelLimits } from '../../shared/model-limits.ts'
import { modelLimitsFor } from '../../shared/model-catalog.ts'
import { mergedModelCatalog } from '../model-catalog-store.ts'
import { NODE_PART, runEngineTurn, type AgentCall, type AgentResult, type EngineHost } from '../../shared/engine.ts'
import { projectFormat } from '../../shared/file-format.ts'
import { composeRole, includedAgents, nodeAgentRun } from '../../shared/agent-role.ts'
import { fillSkills } from '../../shared/expose.ts'
import { listIntegrations } from '../integrations.ts'
import { ensureBundled } from '../bundled-skills.ts'
import { gitChanges } from './git.ts'
import { invokeCli, type CliControl } from './invoke.ts'
import { setLimits } from '../cli-extras.ts'
import type { BuildOptions } from '../../shared/clis.ts'
import type { AskReply, CliEvent } from './parsers.ts'
import { childEnv } from './process.ts'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'
import { AUTO_ANSWER } from '../asks.ts'
import { orchHint } from '../orch-mcp.ts'
import { hasViewer, isWatched, seenWhileWatched } from '../presence.ts'

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
  takeInbox?: EngineHost['takeInbox']
  messageParent?: EngineHost['messageParent']
  claimFiles?: EngineHost['claimFiles']
  releaseFiles?: EngineHost['releaseFiles']
}

/** 等用户确认的请求：请求 id → 把结果交回 CLI 的函数。只在内存里，服务重启后 CLI 进程也不在了 */
const replies = new Map<string, (r: AskReply) => void>()

/** 正在跑的一次 CLI 调用里能接收补充的那个：step 为空是对话，否则是工作流节点 */
interface Steerer {
  step: string
  agentId: string
  steer: (text: string) => Promise<boolean>
  /** 补充交给了它：之后的输出另起一条，排在用户消息后面 */
  accepted: () => void
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
  /** 用户发来下一句：记进对话再交给正在等的 CLI */
  deliver: (msg: TaskMessage) => void
  /** 用户离开了：结束等待 */
  cancel: () => void
  /** 输入框里的 CLI/模型/强度还是启动这个进程时的那一套 */
  current: () => boolean
}
const waiters = new Map<string, Set<Waiter>>()

/** 预热时不记进对话的事件：正文、思考、工具和待办 */
const PREWARM_QUIET = new Set(['thinking', 'text_delta', 'text', 'tool', 'tool_result', 'tool_delta', 'todos'])

/**
 * 把用户消息交给正在等下一句的 CLI。
 * 没有在等时返回 none；等着的进程已经不是输入框里的选择时返回 stale，
 * 调用方等它退出后按新的选择重新开始，不能把消息交给旧 CLI。
 */
export function deliverWait(task: Task, msg: TaskMessage): 'ok' | 'stale' | 'none' {
  const w = waiters.get(task.id)?.values().next().value
  if (!w) return 'none'
  if (!w.current()) {
    w.cancel()
    return 'stale'
  }
  w.deliver(msg)
  return 'ok'
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

/**
 * 交给 CLI 的补充。对话里先让模型判断这条补充和当前任务的关系：
 * 相关就调整方向；无关就先做完手上的事，再处理这条，别把当前任务丢在半路。
 * 工作流里交给正在跑的节点，按原来的说法结合当前任务处理。
 */
export const steerNote = (text: string, chat: boolean) =>
  chat
    ? '用户在你执行中补充了信息。先判断它和当前任务的关系：\n' +
      '- 相关（对当前任务的调整、修改或补充）：按它调整方向，继续当前任务；\n' +
      '- 无关：先简短说明会等当前任务完成后再处理，然后继续手上的事，不要现在开始做它；当前任务做完后再处理这条内容。\n\n' +
      `补充的内容：\n${text}`
    : `用户在执行中补充了信息，请结合它继续当前的任务：\n${text}`

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
  const all = steers.get(task.id) ?? []
  const took: Steerer[] = []
  for (const s of all) if (await s.steer(steerNote(text, task.mode === 'chat'))) took.push(s)
  if (took.length) {
    // 工作流里的补充记在节点上：不算任务的新要求（继续执行时不会把它当成要求重跑）
    const at = took[0]
    task.messages.push({ ...msg, step: at.step, agentId: at.step ? at.agentId : msg.agentId })
    for (const s of took) s.accepted()
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
const MAX_LIVE_OUTPUT = 8000
const tail = (s: string) => (s.length > MAX_LIVE_OUTPUT ? '…' + s.slice(-MAX_LIVE_OUTPUT) : s)

/** 对话撤回、分叉后 CLI 不能截断会话时，把留下的对话整理成文字带给新会话 */
function transcript(task: Task, upto: number) {
  const lines: string[] = []
  for (const m of task.messages.slice(0, upto)) {
    if (m.step || m.role === 'system' || !m.text.trim()) continue
    lines.push(`${m.role === 'user' ? '用户' : '你'}：${m.text.trim()}`)
  }
  return lines.join('\n\n')
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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

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
/** 自动续接前写进对话的报错：续接成功后要收回成普通说明 */
export interface NetNote {
  msg: TaskMessage
  base: string
  n: number
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
  }
}
const NETWORK_ERROR =
  /Connection error|APIConnectionError|Unable to connect to the API|Failed to process successful response|Stream connection failed|stream (disconnected|closed|error)|ECONNRESET|ETIMEDOUT|socket hang up|network (error|connection)/i

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
        cli: cli?.name ?? 'CLI',
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
  // Google 已经不让个人账号用 Gemini CLI（服务端限制）：个人账号登录会直接报这个错
  if (/IneligibleTierError|no longer supported for Gemini Code Assist/i.test(detail))
    hints.push(
      t(
        '· Google 已不再支持用个人账号（Gemini Code Assist for individuals）登录 Gemini CLI，这是 Google 服务端的限制，不是面板的问题。可以改用 API：在设置的「API 配置」里添加 Gemini 的 API Key（到 aistudio.google.com 获取），再到 Gemini CLI 页面把「登录方式」切到 API；Google Workspace 或付费的 Code Assist 账号仍然可以用账号登录。',
      ),
    )
  if (NETWORK_ERROR.test(detail))
    hints.push(
      t(
        '· 和模型服务的连接中途断开了。常见于一次要输出很长的内容（例如写入一个大文件）时，连接被服务端或代理断开；可以点「继续执行」重试，或者换一个接口、让 Agent 分几次写。',
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
async function runAgent(
  ctx: RealContext,
  call: AgentCall,
  retried = false,
  netRetries = 0,
  retryCarry = '',
  /** 这一串自动续接里已经写进对话的报错：续接成功后要收回成普通说明 */
  netNotes: NetNote[] = [],
): Promise<AgentResult> {
  const { agentId, prompt, sessionKey } = call
  const step = call.step?.id ?? ''
  const { task, settings, project } = ctx
  // agentId 为空表示这个对话不用 Agent 角色：直接用默认 CLI，不注入角色设定
  const found = agentId
    ? ctx.agents.find((a) => a.id === agentId)
    : { ...defaultAgent(), id: '', name: '', description: '' }
  if (!found) return { ok: false, error: t('找不到执行这一步的 Agent，可能已被删除') }
  // 工作流里的调用固定用默认 CLI 的档位；对话可以用 Agent 自己的 CLI，默认 Agent 还能临时换模型
  const agent =
    call.tier !== undefined ? nodeAgentRun(found, call.tier, defaultCli(settings)) : withTaskModel(found, task)
  const run = agentRun(agent, settings)
  const cliId = run.cli
  const def = getCli(cliId)
  if (!def) return { ok: false, error: t('未知的 CLI：{cli}', { cli: cliId }) }
  const cs = cliSettings(settings, cliId)
  if (!cs.enabled) return { ok: false, error: t('{cli} 在设置里被停用了', { cli: def.name }) }
  if (!agent.enabled) return { ok: false, error: t('Agent「{name}」已停用', { name: agent.name }) }
  const cwd = project.path
  const dir = await stat(cwd).catch(() => null)
  if (!dir?.isDirectory()) return { ok: false, error: t('项目目录不存在：{dir}', { dir: cwd || t('（未设置）') }) }

  const model = run.model
  // 模型不认的思考强度会让 CLI 启动即报错退出：挡在这里，下面记下的启动命令和日志才和实际调用的参数一致
  // 模型目录里的默认思考强度：没有手动指定时用它；目录里没有的模型交给 CLI 自己决定
  const entries = await mergedModelCatalog().catch(() => [])
  // API 设置里给这个模型配了映射时，默认思考强度按映射到的模型算
  const catalogInfo = modelLimitsFor(cs.api?.modelMap?.[model] || model, { entries, protocol: cs.api?.protocol })
  // API 设置里给这个模型配的默认思考强度优先，其次才是模型目录的默认值
  const defaultEffort = cs.api?.modelEfforts?.[model] || (catalogInfo.matched ? catalogInfo.defaultEffort : '')
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
  const known = modelLimitsFor(cs.api?.modelMap?.[model] || model, { entries, protocol: cs.api?.protocol })
  const limits: ModelLimits = {
    context: manual.context || (known.matched ? known.context : undefined),
    maxOutput: manual.maxOutput || undefined,
  }
  const op = call.op
  // 对话（不属于节点的调用）才能插话、分叉、撤回
  const chat = !step && sessionKey === task.agentId && task.mode === 'chat'
  const prewarm = chat && !!call.prewarm
  // 启动这一轮时的选择；执行中换了 CLI/模型/强度，结束时不能还停在旧进程上等下一句
  const startPick = { cli: task.cli, model: task.model, effort: task.effort }
  const stillCurrent = () => {
    const now = agentRun(withTaskModel(found, task), settings)
    return now.cli === cliId && now.model === model && task.effort === startPick.effort
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
  // 对话中途换了 CLI、模型或（不支持中途换强度的 CLI 换了）思考强度：原来的会话接不上，开新会话把之前的对话带过去
  const switched = chat && sessionChanged(task, cliId, model, effort, def.effortBoundSession)
  if (switched) resume = undefined
  if (retryCarry) {
    // 接口拒绝了旧会话的历史：丢掉它重开，把之前的对话带上
    resume = undefined
    carry = retryCarry
  } else if (rewind || switched) {
    const th = rewind?.through ?? null
    resume = undefined
    if (rewind?.summary) carry = `## 之前对话的摘要\n${rewind.summary}`
    else if (switched) {
      const upto = asker ? task.messages.indexOf(asker) : task.messages.length
      carry = carryPrompt(task, upto)
    } else if (th && def.fork === 'turn' && th.id) [resume, fork] = [th.session, { turnId: th.id }]
    else if (th && def.fork === 'end' && th.end) [resume, fork] = [th.session, { end: th.end }]
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
  const instructions = composeRole(agent, ctx.agents, call.params ?? (step ? {} : task.params), task.skillSlots).trim()
  // Agent 要用的自带 Skill 统一补到 ~/.agents/skills，提示里点名的 Skill 才找得到
  await ensureBundled(
    fillSkills(
      [...new Set([...agent.skills, ...includedAgents(agent, ctx.agents).flatMap((x) => x.agent.skills)])],
      task.skillSlots,
    ),
  )
  let input = op?.kind === 'review' && def.review !== 'native' ? reviewPrompt(op.target) : prompt
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
  if (instructions && !def.systemPromptFlag && !resume) {
    // 节点的角色设定放在各节点共用的部分（需求、工作流说明）后面：不同 Agent 的节点开头一样，按前缀匹配的缓存能命中
    const role = `## 你的角色\n${instructions}\n\n`
    const at = step ? input.indexOf(`\n\n${NODE_PART}\n`) : -1
    input = at < 0 ? role + input : `${input.slice(0, at + 2)}${role}${input.slice(at + 2)}`
  }
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
    // 附件在面板的数据目录里，不在项目目录下；Claude Code 读工作目录外的文件要先放行
    // 节点交接的完整结果也在数据目录里
    addDirs: [
      ...(task.messages.some((m) => m.attachments?.length) ? [UPLOADS_DIR] : []),
      ...(existsSync(path.join(HANDOFF_DIR, task.id)) ? [path.join(HANDOFF_DIR, task.id)] : []),
    ],
    autoCompactTokens: pct && def.autoCompact === 'config' ? Math.floor((windowFor(model) * pct) / 100) : undefined,
    contextWindow: limits.context || undefined,
    maxOutput: limits.maxOutput || undefined,
  }
  const env = childEnv([
    ...cs.env,
    ...(pct && def.autoCompact === 'env' && def.autoCompactEnv
      ? [{ key: def.autoCompactEnv, value: String(pct) }]
      : []),
    // 用户在环境变量里自己写了同名的，以设置里这一档的值为准（写在后面）
    ...limitEnvVars(def, limits),
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
  let cur: TaskMessage | undefined
  const texts: string[] = []
  const errors: string[] = []
  let result: { ok: boolean; error?: string } | undefined
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
      const changes = await gitChanges(cwd, task.baseline, task.baseRef).catch(() => null)
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

  const apply = (ev: CliEvent) => {
    // 预热时模型可能先回一句话再调用等待工具：这些不显示，也不占消息
    if (prewarmMode && PREWARM_QUIET.has(ev.type)) return
    // 延迟取走的补充：CLI 开始下一次模型请求时说明它真的接受了补充，之后的输出另起一条。
    // 消息本身在交出去时就已经记进对话，这里只断开输出
    if (steerPending && ev.type === 'request_start') {
      steerPending = false
      cur = undefined
      prewarmMode = false
      task.prewarming = false
      task.working = true
      ctx.changed(true)
    }
    switch (ev.type) {
      case 'session':
        task.sessions[sessionKey] = ev.id
        if (chat) task.sessionCli = cliId
        break
      case 'thinking': {
        // 思考属于接下来的那段回复：当前消息已经有文字或工具时另起一条
        const m = !cur || cur.text.trim() || cur.tools.length ? newMsg() : cur
        m.thinking = ev.delta ? (m.thinking ?? '') + ev.text : ev.text
        streamed(ev.text)
        break
      }
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
        if (ev.id) toolsById.set(ev.id, ev.tool)
        if (ev.file) touched.add(ev.file.path.replaceAll('\\', '/'))
        if (ev.file) refreshChanges()
        if (ev.file && !ctx.isGit) {
          mergeChanges(task.changes, [ev.file])
          if (owner) mergeChanges((owner.changes ??= []), [ev.file])
        }
        break
      }
      case 'usage': {
        const u = au()
        if (ev.model) u.model = ev.model
        if (ev.context !== undefined) u.context = ev.context
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
      case 'tool_result': {
        // 工具的输出晚于调用到达，补到对应的那一行上
        const t = toolsById.get(ev.id)
        if (t) {
          if (ev.output) t.output = ev.output
          if (ev.failed) t.failed = true
          if (ev.patch) t.input = ev.patch
          if (ev.detail !== undefined) t.detail = ev.detail
          delete t.running
        }
        break
      }
      case 'tool_delta': {
        const t = toolsById.get(ev.id)
        // 快照是到目前为止的全部输出（Pi 每次都给完整的一段），直接替换；其余是新增的一段，接在后面
        if (t) t.output = ev.snapshot ? tail(ev.text) : tail((t.output ?? '') + ev.text)
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
      case 'result':
        result = ev
        // 一轮结束以 CLI 的 result 为准：进程还活着也可能已经回复完了
        if (chat && !op) {
          task.working = false
          if (ev.ok && !prewarmMode) markTurnDone(task)
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
  const register = (c: CliControl) => {
    steerer = {
      step,
      agentId,
      steer: c.steer,
      accepted: () => {
        // CLI 收下了补充：这一轮又在处理了；延迟取走的那些等它真正开始下一次生成再断开输出
        task.working = true
        if (c.deferSteer) steerPending = true
        else cur = undefined
        ctx.changed(true)
      },
    }
    ;(steers.get(task.id) ?? steers.set(task.id, new Set()).get(task.id)!).add(steerer)
  }
  const idleMinutes = settings.idleTimeoutMinutes
  // 测试用：环境变量把「一分钟」缩短成几百毫秒，免得端到端测试真的等上几分钟
  const idleMs = idleMinutes * (Number(process.env.AGENT_PANEL_MINUTE_MS) || 60_000)
  // 对话的 CLI 能用面板的工具：没有插话协议时取补充（read_user_notes）；有协议自己提问的（Claude、Codex）不用 MCP
  const canWait = chat && !op && def.notes && def.mcp && !def.rpc?.nativeAsk
  let taker: NoteTaker | undefined
  /** 登记了、CLI 还没取走的补充：消息已经在对话里，这一轮结束前没取走的交给下一轮接着处理 */
  const pendingNotes = new Set<TaskMessage>()
  if (canWait && !def.steer) {
    taker = {
      add: (msg) => pendingNotes.add(msg),
      read: () => {
        const mine = [...pendingNotes]
        if (!mine.length) return []
        pendingNotes.clear()
        // 拿到就算交出去了：之后的输出另起一条，排在用户消息后面
        cur = undefined
        ctx.changed(true)
        return mine.map((m) => steerNote(withAttachments(m.text, m.attachments ?? []), task.mode === 'chat'))
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
  const waitNext = async (fromTool: boolean): Promise<string | null> => {
    if (fromTool) {
      if (finished) return null
      toolWaited = true
    }
    // 用户在这一轮执行中换了 CLI/模型/强度：旧进程不要再等下一句，结束后按新的选择重开
    if (chat && !stillCurrent()) return null
    // 这一轮没取走的补充：不再挂着等下一句，直接结束这一轮，由调用方马上开始新一轮接着处理
    if (pendingNotes.size) return null
    task.prewarming = false
    task.awaitingUser = true
    // 停在等待上：空闲时间记进等待，不算执行。keepAlive 会让这次调用一直不返回
    if (!prewarmMode) pauseRun(task)
    // CLI 回复完停在等下一句：这一轮已经结束，页面不再显示执行中
    task.working = false
    // 真正处理过用户消息的轮次才算完成；预热还没处理消息时不算
    if (!prewarmMode && chat && !op) markTurnDone(task)
    ctx.changed(true)
    try {
      return await new Promise<string | null>((resolve) => {
        let settled = false
        const done = (value: string | null) => {
          if (settled) return
          settled = true
          ctx.signal.removeEventListener('abort', onAbort)
          const set = waiters.get(task.id)
          if (waiter) set?.delete(waiter)
          if (!set?.size) waiters.delete(task.id)
          waiter = undefined
          task.awaitingUser = false
          task.prewarming = false
          if (value === null && chat) task.working = false
          if (!finished) ctx.changed(true)
          resolve(value)
        }
        const onAbort = () => done(null)
        waiter = {
          deliver: (msg) => {
            // 用户发来第一句：预热结束，之后模型的输出正常记进对话
            prewarmMode = false
            task.messages.push(msg)
            // 继续执行：等待到此结束，从这一刻重新算执行时间
            resumeRun(task)
            // 收到用户消息，CLI 开始处理这一轮
            task.working = true
            // 之后的输出另起一条，排在用户消息后面
            cur = undefined
            done(withAttachments(msg.text, msg.attachments ?? []))
          },
          cancel: () => done(null),
          current: stillCurrent,
        }
        ;(waiters.get(task.id) ?? waiters.set(task.id, new Set()).get(task.id)!).add(waiter)
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        // 页面已经离开（宽限过了）：不再一直挂着，让 CLI 结束这一轮
        if (!isWatched(task.id)) done(null)
      })
    } finally {
      if (task.awaitingUser || task.prewarming) {
        task.awaitingUser = false
        task.prewarming = false
        if (!finished) ctx.changed(true)
      }
    }
  }
  const waitUser = canWait ? () => waitNext(true) : undefined
  // 面板保活：回复完这一轮不关进程，用户的下一条消息交给同一个进程开下一轮（不靠模型主动调等待工具）。
  // 只在对话页确实开着时这样做：没人看的时候留着一个 CLI 也没人会回来发消息
  const keepAlive = canWait
    ? async () => {
        if (!hasViewer(task.id)) return null
        const text = await waitNext(false)
        // 拿到下一句就是新一轮开始了：上一轮模型有没有等过，跟新一轮无关
        if (text !== null) toolWaited = false
        return text
      }
    : undefined

  const r = await invokeCli({
    cliId,
    command: cs.command,
    build,
    cwd,
    env,
    input,
    signal: ctx.signal,
    // 0 表示不限制
    timeoutMs: settings.stepTimeoutMinutes ? settings.stepTimeoutMinutes * 60_000 : 0,
    idle: idleMs
      ? {
          ms: idleMs,
          // 在等用户确认、回答或下一句时 CLI 本来就没有输出，不算卡住
          busy: () => task.awaitingUser || task.requests.some((x) => asked.includes(x.id)),
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
              at: new Date().toISOString(),
            })
            ctx.changed(true)
          },
        }
      : undefined,
    onEvent: apply,
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
  }).finally(() => {
    finished = true
    // CLI 一直没报告开始下一次模型请求：补充也算交给了它，输出直接另起一条
    if (steerPending) {
      steerPending = false
      cur = undefined
    }
    // 进程先结束了（崩溃、被停掉）：还在等下一句的那次请求也结束，别一直挂着
    cancelWait(task.id)
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
    meter.stop()
    // 进程结束了（完成、停止、超时），还没回答的请求作废
    for (const id of asked) replies.delete(id)
    task.requests = task.requests.filter((x) => !asked.includes(x.id))
    if (task.usage.agents[agentId]) task.usage.agents[agentId].tps = 0
  })

  for (const m of mine) if (m.text && m.role === 'agent') texts.push(m.text)
  // 记下这一轮在会话里的位置，分叉、撤回时让 CLI 从这里截断
  if (asker && task.sessions[sessionKey])
    asker.turn = { session: task.sessions[sessionKey], id: turn.id, end: turn.end }
  if (ctx.isGit) {
    const changes = await gitChanges(cwd, task.baseline, task.baseRef).catch(() => null)
    if (changes) {
      // 同时在跑的节点的改动也会出现在差值里：CLI 报告了改哪些文件时只算这些，没报告（例如用命令写的）才全算
      const mine = changesSince(before, changes).filter((c) => !touched.size || touched.has(c.path))
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
  // 停止时 CLI 自己中断了这一轮（进程正常退出），也算停止
  if (r.killed === 'stopped' || (ctx.signal.aborted && !r.killed))
    return { ok: false, stopped: true, error: t('已停止') }
  if (r.killed === 'timeout')
    return { ok: false, error: t('超过 {n} 分钟没有完成，已停止', { n: settings.stepTimeoutMinutes }) }
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
  if (r.spawnError)
    return {
      ok: false,
      error: t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写可执行文件的完整路径。', {
        error: r.spawnError,
        cli: def.name,
        hint: def.installHint,
      }),
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
      return runAgent(ctx, call, true)
    }
    // 会话找不到时（例如 CLI 清理了历史），丢掉会话重新开始一次
    if (
      resume &&
      !prewarm &&
      !retried &&
      /(no|not).{0,40}(session|conversation|thread)|(session|conversation|thread).{0,40}not found/i.test(detail)
    ) {
      delete task.sessions[sessionKey]
      // 新会话没有之前的上下文，要用完整提示
      return runAgent(ctx, { ...call, prompt: call.fresh ?? call.prompt }, true)
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
      const carry = chat
        ? `## 之前的对话\n${transcript(task, asker ? task.messages.indexOf(asker) : task.messages.length)}`
        : ''
      log.warn('agent', `${def.name} 的会话和当前模型不兼容，丢掉旧会话重开`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      return runAgent(ctx, chat ? call : { ...call, prompt: call.fresh ?? call.prompt }, true, netRetries, carry)
    }
    const hints = failureHints(detail, def)
    const head =
      r.code !== null && r.code !== 0
        ? t('{cli} 执行失败（退出码 {code}）：', { cli: def.name, code: r.code })
        : t('{cli} 执行失败：', { cli: def.name })
    const raw = clip(detail || t('没有更多信息'), 1500)
    const message = [head, ...hints, hints.length ? `\n${t('原始输出：')}\n${raw}` : raw].join('\n')
    // 连接中途断开（多半是输出很长时被服务端或代理断开）：有会话就续接让它接着做，最多两次。
    // 每次断开都把完整报错写进节点里再续接，不能悄悄重试，否则页面上只看到 Agent 反复说同一句话
    const session = task.sessions[sessionKey]
    if (NETWORK_ERROR.test(detail) && session && !prewarm && netRetries < MAX_NET_RETRIES && !ctx.signal.aborted) {
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
      )
    }
    log.error('agent', `${def.name} 执行失败`, { task: task.id, step, code: r.code, detail })
    return {
      ok: false,
      error: netRetries ? [message, '', t('已自动续接 {n} 次，仍然失败。', { n: netRetries })].join('\n') : message,
    }
  }
  log.info('agent', `${def.name} 完成`, { task: task.id, step })
  // 续接成功了：之前那次断开的报错已经不成立，收成普通说明（否则对话里一直留着一张红色「执行失败」卡片）
  settleNetNotes(netNotes)
  if (netNotes.length) ctx.changed(true)
  const done: AgentResult = { ok: true, text: texts.join('\n\n') }
  // 赋成 undefined 而不是 delete：保存时和旧记录合并，delete 掉的字段会被旧值补回来
  if (rewind) task.rewind = undefined
  const sysMsg = (text: string, error?: boolean) => {
    task.messages.push({
      id: ctx.newId(),
      role: 'system',
      agentId,
      step,
      text,
      tools: [],
      ...(error ? { error } : {}),
      at: new Date().toISOString(),
    })
    ctx.changed(true)
  }
  // 不能压缩会话的 CLI：摘要写好了，下一轮开新会话带上它
  if (op?.kind === 'compact' && def.compact === 'summary') {
    task.rewind = { session: '', through: null, latest: false, summary: done.text }
    delete task.sessions[sessionKey]
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
    const c = await runAgent(ctx, { ...call, op: { kind: 'compact' } })
    if (!c.ok && !c.stopped) sysMsg(t('自动压缩失败：{error}', { error: c.error }), true)
  }
  return done
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
    workflowCatalog: ctx.workflowCatalog,
    resolveWorkflow: ctx.resolveWorkflow,
    listConversations: ctx.listConversations,
    createConversation: ctx.createConversation,
    sendToConversation: ctx.sendToConversation,
    rules: ctx.rules,
    takeInbox: ctx.takeInbox,
    messageParent: ctx.messageParent,
    claimFiles: ctx.claimFiles,
    releaseFiles: ctx.releaseFiles,
    runAgent: (call) => runAgent(ctx, ctx.op && !call.step ? { ...call, op: ctx.op } : call),
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
    saveHandoff: async (step, text) => {
      const dir = path.join(HANDOFF_DIR, ctx.task.id)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `${step.id}.md`)
      await writeFile(file, `# ${step.title}\n\n${text}\n`)
      return file
    },
  })
}

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

/** 压缩上下文的工具调用：一行写压缩了多少，右边写现在占上下文窗口多少，点开看明细 */
export function describeCompaction(tool: ToolUse, before?: number, after?: number, window?: number) {
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
