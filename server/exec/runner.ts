import { noteCommandTime } from '../command-times.ts'
import { turnInfo } from './turn-info.ts'

import { stat } from 'node:fs/promises'
import {
  aliasAgent,
  type AgentUsage,
  type Task,
  type TaskMessage,
  type ToolUse,
  type Alert,
} from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { hookMarker } from '../../shared/hooks.ts'
import { addFirstToken } from '../../shared/first-token-stats.ts'
import { hookOptions } from '../hooks/dispatch.ts'
import { addNoteTaker, holdForNextTurn, removeNoteTaker, type NoteTaker } from './delivery.ts'

import { agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import {
  changesSince,
  mergeChanges,
  ownedChanges,
  pauseRun,
  resumeRun,
  stepUsage,
  withAttachments,
  withTaskModel,
} from '../../shared/task.ts'

import { effectiveTimeoutMinutes } from '../../shared/schedule.ts'
import { placedFiles } from '../attachments.ts'
import { taskChanges } from '../own-changes.ts'
import { trackFileWrite, trackOutside } from './outside-changes.ts'
import { taskFiles } from '../task-files.ts'
import { noPushEnv } from './no-push.ts'

export { noPushEnv } // 拆到 no-push.ts，原来从这里引用的地方不用改
import { effortRejected, markNoEffort } from '../models.ts'
import { stripLongContext } from '../../shared/model-limits.ts'
import { modelLimitsFor } from '../../shared/model-catalog.ts'
import { priceCost } from '../../shared/model-price.ts'
import { helperGate, type AgentCall, type AgentResult } from '../../shared/engine.ts'

import { clip } from '../../shared/text.ts'
import {
  CONTEXT_CARRY_SHARE,
  MIN_CLIP_TOKENS,
  clippedTranscript,
  contextFallbackKind,
  estTokens,
  restartCarry,
} from './transcript.ts'
export { clippedTranscript, contextFallbackKind, estTokens, restartCarry }
import {
  SESSION_NOT_FOUND,
  cliSwitchedText,
  systemNote,
  firstNoEffortTell,
  noEffortRetryText,
  noEffortSkippedText,
  restartNoteText,
  settleContextNotes,
  settleNetNotes,
  settleRetryNotes,
  type ContextNote,
  type NetNote,
} from './recovery.ts'
export { SESSION_NOT_FOUND, settleContextNotes, settleNetNotes, settleRetryNotes, type ContextNote, type NetNote }
import {
  awaitingCompact,
  overflowCompact,
  CompactTracker,
  settleCompactRow,
  shouldRetryThrash,
  thrashNote,
  THRASH_RETRY_PROMPT,
} from './compaction.ts'
import { composeRole, includedAgents, nodeAgentRun } from '../../shared/agent-role.ts'
import { fillSkills } from '../../shared/expose.ts'

import { ensureBundled, sharedRoot } from '../bundled-skills.ts'
import { withSkillDir } from '../../shared/skill-guide.ts'

import { invokeCli, type CliControl } from './invoke.ts'
import { setLimits } from '../cli-extras.ts'
import type { CliEvent } from './parsers.ts'
import { exitReason, stderrTail } from './process.ts'

import { REDIRECT_LIMITS, REDIRECT_NOTE, redirectWait } from './redirect.ts'
import { t } from '../../shared/i18n.ts'

import { promptLangRules, promptUserNameRules } from '../../shared/prompt-lang.ts'
import { compactedSilently } from '../../shared/prompt-delta.ts'
import { ensurePromptLangMod } from './prompt-lang-mod.ts'
import { log } from '../log.ts'
import { sourceHeader } from '../../shared/peer-message.ts'
import { taskLog } from '../task-log.ts'

import { dropAsked } from '../../shared/task-settle.ts'
import { askViaParent } from './child-question.ts'
import { replies } from './panel-requests.ts'
import { autoAllowed, requestOf } from './ask-request.ts'

import { turnRole } from '../../shared/conv-mode.ts'
import { pluginRunTools } from './plugin-run.ts'
import { hasViewer, isWatched, seenWhileWatched } from '../presence.ts'
import { ApiSlot } from '../api-slots.ts'
import { beginTurnChanges, endTurnChanges, settleTurnChanges, summaryMessage } from '../turn-changes.ts'
import { noteEdit } from '../turn-owners.ts'
import { addWaiter, removeWaiter, userWaitSlot, type Waiter } from './waiters.ts'
import {
  EFFORT_REJECTED,
  EnvStallNote,
  MAX_NET_RETRIES,
  SESSION_OTHER_PROJECT,
  canKeepAlive,
  envStallBudget,
  envStallFailure,
  envStallNote,
  envStallTimeout,
  failureHints,
  forgetPromptSent,
  isNetError,
  settleEnvStallNotes,
  shouldRetryEnvStall,
  silentTurn,
} from './retry-policy.ts'
import { type Steerer, cancelWait, flushHeld, notes, steerNote, steers } from './steering.ts'
import { anySignal, apiSlots, callApi, inToolWait, slotKey, takeApiSlot } from './api-gate.ts'
import { speedMeter } from './speed-meter.ts'
import type { RealContext } from './real-context.ts'
import { createStallWatch } from './stall-watch.ts'
import { noticeRow } from './notice-row.ts'
import { warnSlowMcp } from './mcp-probe.ts'
import { bugSlash } from './bug-prompt.ts'
import { createFileEvents } from './file-events.ts'
import { NOT_RESPONSE, PREWARM_QUIET, continuesOutput } from './event-kinds.ts'
import { createDrafting } from './drafting.ts'
import { createToolRows } from './tool-rows.ts'
import { makeStillCurrent } from './still-current.ts'
// runAgent 里职责完整的几块拆在这些文件：模型和上限、选会话、拼输入、启动参数、进程没跑完一轮时交回什么
import { resolveModelRun, windowLookup } from './model-run.ts'
import { pickSession } from './session-pick.ts'
import { composeInput } from './compose-input.ts'
import { launchOptions } from './launch-options.ts'
import { exitResult, idleWarning } from './exit-result.ts'
// 测试从这里取（以前定义在这个文件里）
export { continuesOutput }

/** 这一轮完成：页面正开着就算已经看过，没开着才留橙点等用户回来看 */
function markTurnDone(task: Task) {
  const now = new Date().toISOString()
  task.turnDoneAt = now
  if (seenWhileWatched(task.id)) task.turnSeenAt = now
}

/** 任务 id → 卡住的这一轮（没得到回应的那条输入）：下一条消息据此停掉卡住的 CLI、接回会话重开 */
export { stalledTurn } from './stall-watch.ts'

/**
 * 按 API 的并发上限执行一次调用（对话这一轮、子任务、工作流节点都从这里进）：
 * 先拿名额再启动 CLI，结束时还回去。名额按 API 计，没设上限的也记着数，改成有上限时马上按实际占用算
 */
export async function gatedRunAgent(ctx: RealContext, call: AgentCall): Promise<AgentResult> {
  const r = await runWithSlot(ctx, call)
  if (call.op?.kind === 'compact') settleCompactRow(call.op, r)
  return r
}

async function runWithSlot(ctx: RealContext, call: AgentCall): Promise<AgentResult> {
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

/** 调用一次 Agent 对应的 CLI，把输出写进任务消息 */
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
  // 子任务卡住到时间由面板停掉这次调用（见下面的「没有响应」检测）：记下是谁停的，返回 stalled 而不是「已停止」
  const stallAc = new AbortController()
  const outerSignal = ctx.signal
  if (call.stallRetry && call.step) ctx = { ...ctx, signal: anySignal(ctx.signal, stallAc.signal) }
  const { agentId, sessionKey } = call
  const step = call.step?.id ?? ''
  const { task, settings, project } = ctx
  // 本轮开始的索引：重试成功时只收这一轮以后的卡（用户插话会往同一轮里再 push user，不能按 role 猜边界）
  const turnStart = task.messages.length
  // agentId 为空表示这个对话不用 Agent 角色：直接用默认 CLI，不注入角色设定
  // 旧快照里记着已经合并删掉的角色时，按登记的转到合并目标（转成空就是不用角色）；Chat 页选的角色被删了按内置助手跑（turnRole）
  const id = ctx.agents.some((a) => a.id === agentId) ? agentId : aliasAgent(agentId)
  const found = turnRole(ctx.task, ctx.agents, id)
  if (!found) return { ok: false, error: t('找不到执行这一步的角色，可能已被删除') }
  if (id && found.id !== id) log.info('agent', 'Chat 对话的角色已被删除，按内置助手跑', { task: task.id, agentId: id })
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
  // 思考强度（模型不认的换掉或去掉）和上下文上限在 model-run.ts 算
  const { entries, requested, effort, manual, limits } = await resolveModelRun(cliId, run, cs)
  const op = call.op
  // 对话（不属于节点的调用）才能插话、分叉、撤回
  const chat = !step && sessionKey === task.agentId && task.mode === 'chat'
  const prewarm = chat && !!call.prewarm
  // 子任务也查「没有响应」：以前只查对话，子任务卡在网关上只剩 30 分钟的空闲超时兜底，派它的对话一直干等
  const helperWatch = !!step && !!call.stallRetry && !op
  // 停在等下一句的进程还配不配得上现在的选择（换了 CLI / 模型 / 强度 / 语言 / 目录）：still-current.ts
  const stillCurrent = makeStillCurrent({ task, found, settings, cliId, model, cwd })
  // 预热期间的输出不记进对话；用户发来第一句后开始正常记
  let prewarmMode = prewarm
  // 接哪个会话、要不要带上之前的对话（换了 CLI / 目录、回退、接口拒绝历史）在 session-pick.ts
  const { resume, fork, carry, asker, rewind } = pickSession({
    task,
    sessionKey,
    cwd,
    chat,
    op: !!op,
    prewarm,
    def,
    cliId,
    model,
    effort,
    retryCarry,
  })
  const windowFor = await windowLookup(cliId, model, limits, cs, entries)
  const role = withSkillDir(
    composeRole(agent, ctx.agents, call.params ?? (step ? {} : task.params), task.skillSlots).trim(),
    sharedRoot(),
  )
  /** 上下文超长降级时留给旧对话的 token 预算：剩下的给角色设定、提示词和这一轮的要求 */
  const carryBudget = () => Math.max(MIN_CLIP_TOKENS * 2, Math.floor(windowFor(model) * CONTEXT_CARRY_SHARE))
  /**
   * 丢会话重开带给新会话的之前的对话，只有对话的普通一轮带：节点用完整提示就够；压缩、审查不带（/compact 前面多了历史
   * 就不再是斜杠命令）。截到哪：用户发起的一轮截在要求之前（要求在提示里）；接着上一圈做的（call.carry）提示里没有用户的要求，带到最新
   */
  const carryUpto = () => (asker && !call.carry ? task.messages.indexOf(asker) : task.messages.length)
  const carryForRestart = () => (chat && !op ? restartCarry(task, carryUpto(), carryBudget()) : '')
  /**
   * 面板换了做法自动重跑（丢会话重开、去掉思考强度）前在对话里留一行：只写日志就是悄悄重试。不设 transient：
   * 继续执行时不能当状态说明弹掉。预热轮用户还没发话不记（思考强度那条由 tellNoEffort 在第一句到了后补）
   */
  const recoveryNote = (text: string, evenPrewarm = false) => {
    if (prewarmMode && !evenPrewarm) return
    task.messages.push(systemNote(ctx.newId(), agentId, step, text))
    ctx.changed(true)
  }
  const noEffortKey = `${task.id}\n${cliId}\n${model}`
  // 选了思考强度、这个模型却因为之前（别的对话、预热轮里）被拒过而不传了：每个对话第一次碰到时说一次
  const tellNoEffort = () => {
    if (prewarmMode || !requested || effort || !effortRejected(cliId, model)) return
    if (firstNoEffortTell(noEffortKey)) recoveryNote(noEffortSkippedText(model, requested))
  }
  tellNoEffort()
  // 会话是另一个 CLI 的（对话里换了、角色改了）：说一声旧会话不再续用。换了后空闲的对话马上预热，预热轮也要记，不然之后没机会说
  if (chat && task.sessions[sessionKey] && task.sessionCli && task.sessionCli !== cliId)
    recoveryNote(cliSwitchedText(task.sessionCli, cliId), true)
  // 支持系统提示词的 CLI：语言规则跟角色设定一起放系统提示词。模型的原生思考主要跟系统提示词走，
  // 只写在任务描述里时不一定遵守（实测 Command Code + DeepSeek 仍按英文系统提示词思考）
  // 设置里的「称呼」也跟角色设定一起走：没有系统提示词参数的 CLI 改了称呼时角色段的哈希变了，会补发一次
  const taskDir = await taskFiles(task.id) // 对话目录：截图和临时文件放这里，规则进系统提示词（见 task-files.ts）
  const instructions = [
    role,
    def.systemPromptFlag ? promptLangRules() : '',
    promptUserNameRules(settings.userName),
    def.systemPromptFlag ? taskDir.rule : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  // Command Code 没有系统提示词参数，改用 --mod 加载的 mod 追加同一段规则（见 prompt-lang-mod.ts）
  const systemPromptModPath = def.systemPromptMod ? await ensurePromptLangMod() : undefined
  // Agent 要用的自带 Skill 统一补到 ~/.agents/skills，提示里点名的 Skill 才找得到
  await ensureBundled(
    fillSkills(
      [...new Set([...agent.skills, ...includedAgents(agent, ctx.agents).flatMap((x) => x.agent.skills)])],
      task.skillSlots,
    ),
  )
  // 这一轮交给 CLI 的输入（补充、/命令、带过去的对话、编排说明、教训、角色设定）在 compose-input.ts 里拼
  const composed = await composeInput({
    ctx,
    call,
    def,
    cliId,
    cwd,
    chat,
    step,
    resume,
    carry,
    instructions,
    taskDir,
    found,
  })
  let input = composed.input
  const orch = composed.orch
  // 启动参数和环境变量（自动压缩、上下文上限、放行的目录这些）在 launch-options.ts
  const { pct, build, env } = await launchOptions({
    ctx,
    def,
    cs,
    agent,
    model,
    effort,
    limits,
    resume,
    fork,
    op,
    chat,
    instructions,
    systemPromptModPath,
    taskDir,
    cwd,
    windowFor,
  })

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
  // 这一轮改了哪些文件，记在这一轮的总结上（见 server/turn-changes.ts）：只有对话自己的轮次记，子任务、节点不记
  const trackChanges = chat && !op && ctx.isGit
  let changesOpen = false
  const openChanges = (carry: boolean) => {
    if (!trackChanges) return
    changesOpen = true
    // 起点存进任务（A10）：面板重启后进行中的那一轮接着这个起点算
    void beginTurnChanges(task.id, cwd, placedFiles(task), carry, {
      saved: task.turnTrack,
      save: (rec) => {
        task.turnTrack = rec
        ctx.changed()
      },
    })
  }
  const closeChanges = () => {
    if (!changesOpen) return
    changesOpen = false
    // 这一刻的消息就是这一轮的：快照要一会儿，等它的时候下一轮可能已经开始往 mine 里加了
    const msgs = turnMsgs()
    void endTurnChanges(task.id, (c) => {
      const m = summaryMessage(msgs)
      if (!m) return
      m.turnChanges = c
      ctx.changed(true)
    })
  }
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
  // 写入等结果成功才记成改动（被钩子拦下、失败的不算），见 file-events.ts
  const fileEvents = createFileEvents(
    cwd,
    (file) => {
      touched.add(file.path.replaceAll('\\', '/'))
      // 非 git 项目没有 git 差异可统计：项目内的并进 changes，项目外的记进 outsideChanges
      if (!ctx.isGit) trackFileWrite(task, owner, cwd, file)
      refreshChanges()
    },
    // 同目录别的对话算每轮改动时要知道这个文件是谁改的（server/turn-owners.ts）
    (file) => noteEdit(task.id, cwd, file, task.parentTaskId || undefined),
  )
  // 还没跑完的工具调用什么时候开始的：结果到了算耗时
  const toolStart = new Map<ToolUse, number>()
  /** 结果到了（或者这一轮结束了还没等到结果）：记下跑了多久 */
  const endTool = (x: ToolUse) => {
    // 被打断、CLI 没报结果的调用也要收掉运行中标记，不然这一行会一直转圈
    delete x.running
    fileEvents.settle(x)
    const t0 = toolStart.get(x)
    if (t0 === undefined) return
    toolStart.delete(x)
    x.ms = Date.now() - t0
    delete x.startedAt
    // 前台命令跑了多久按项目记下：跑过一分钟以上的，下次在前台跑时长命令守卫让它交给后台（command-times.ts）
    if (x.kind === 'run' && task.projectId) noteCommandTime(task.projectId, x.input ?? x.label, x.ms)
  }
  // 按调用 id 找工具行，补晚到的结果和边跑边来的输出（tool-rows.ts）
  const toolRows = createToolRows(endTool)
  // 正在思考的那条消息和第一段思考到达的时刻：思考之后来了别的输出，思考就结束了
  let thinkingOf: { m: TaskMessage; at: number } | undefined
  // 刚压缩完、还不知道压缩后多大：下一次报告上下文用量时补到这次压缩的工具调用上
  // 压缩那一行：一开始就转圈，压缩完成换成前后大小；不知道压缩后多大时等用量或细分补上
  const compaction = new CompactTracker(endTool, awaitingCompact(task.messages, agentId, step))
  /** 会话压缩过：作废已发的规则段落和角色记录，告诉调用方别把压缩前的记录写回去 */
  const compacted = () => {
    forgetPromptSent(task, sessionKey)
    call.onCompacted?.()
  }
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
      const changes = await taskChanges(cwd, task, touched).catch(() => null)
      gitBusy = false
      // 项目外的写文件不在 git 差异里：和项目内的一起边跑边更新
      const outside = finished ? 0 : trackOutside(task, cwd, touched)
      if (!finished && (changes || outside)) {
        if (changes) task.changes = changes
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
    closeChanges()
    ctx.onTurnEnd?.(turnInfo(turnTools(), turnMsgs()))
  }
  const watch = createStallWatch({
    task,
    step,
    agentId,
    cli: def.name,
    watch: (chat && !op) || helperWatch,
    helper: helperWatch,
    input: call.prompt,
    // 在等用户、等子任务、等确认：本来就没有输出（子任务不看对话在不在等用户：那是派它的对话的状态）。
    // 还有工具在跑（并行调用里先回来一个结果）：等的是工具，不是模型；排队等 API 名额时消息还没交给 CLI
    busy: () =>
      !!(
        (!helperWatch && task.awaitingUser) ||
        waitingHelpers ||
        (helperWatch ? call.step?.apiWait : task.apiWait) ||
        toolStart.size ||
        task.requests.some((x) => asked.includes(x.id))
      ),
    off: () => finished || prewarmMode,
    newId: ctx.newId,
    changed: () => ctx.changed(true),
    kill: () => stallAc.abort('stalled'),
  })
  const { arm, heard } = watch
  let quietBefore = 0 // 重试提示前安静了多久：heard() 清零前记下
  const drafting = createDrafting(task, () => ctx.changed())
  const apply = (ev: CliEvent) => {
    // 有了真正的输出：不算卡住。工具结果交回去、开始一次模型请求后，重新开始等模型的回应
    if (ev.type === 'notice') quietBefore = watch.quietMs()
    if (!NOT_RESPONSE.has(ev.type)) heard()
    drafting.see(ev)
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
        // 会话换了（找不到、换了 CLI / 目录后开的新会话）：记下前后，「状态」诊断里看得出这是第几个会话、为什么换（ADR 0042）
        if (task.sessions[sessionKey] && task.sessions[sessionKey] !== ev.id)
          taskLog(task.id, '换了新会话', { key: sessionKey, from: task.sessions[sessionKey], to: ev.id })
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
        if (ev.id) toolRows.added(ev.id, ev.tool)
        // 调用时就带着耗时的（完成后才报的）直接用；要等结果的从现在开始计时
        if (ev.tool.ms === undefined && (ev.id || ev.tool.running)) {
          ev.tool.startedAt = Date.now()
          toolStart.set(ev.tool, ev.tool.startedAt)
          // 补充还排着时又开始跑命令：同样要等它跑完才取，一起计时
          if (steerPending && !redirectTimer) checkRedirect()
        }
        fileEvents.track(ev.tool, ev.file, toolStart.has(ev.tool))
        break
      }
      case 'usage': {
        usageSeen = true
        const u = au()
        // 报回来的模型名去掉长上下文后缀（[1m]），显示和按模型查映射、目录都用原名
        if (ev.model) u.model = stripLongContext(def, ev.model)
        if (ev.context !== undefined) {
          // 对话的会话里上下文骤降：CLI 自己压缩了却没报 compacted，同样作废已发的规则段落
          if (chat && compactedSilently(u.context, ev.context)) compacted()
          u.context = ev.context
        }
        if (ev.window) {
          u.window = ev.window
          reported = true
        } else if (!reported) u.window = windowFor(u.model || model)
        if (ev.context !== undefined) compaction.measured(ev.context, u.window)
        u.outputTokens = (u.outputTokens ?? 0) + (ev.addOutput ?? 0)
        meter.real(ev.addOutput ?? 0)
        // 任务的累计和节点自己的都记一份，右栏点了节点时只看节点的
        for (const t of owner ? [task.usage, stepUsage(owner)] : [task.usage]) {
          t.inputTokens += ev.addInput ?? 0
          t.outputTokens += ev.addOutput ?? 0
          t.cacheReadTokens = (t.cacheReadTokens ?? 0) + (ev.addCacheRead ?? 0)
          t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + (ev.addCacheWrite ?? 0)
          // CLI 不报费用（Codex、Command Code）时按模型目录里填的单价折算（shared/model-price.ts）
          t.costUsd += ev.addCost ?? priceCost(modelLimitsFor(u.model || model, { entries }).entry?.price, ev)
        }
        if (owner?.usage) Object.assign(owner.usage, { context: u.context, window: u.window, model: u.model })
        break
      }
      case 'context': {
        // CLI 自己报的上下文细分：会话栏优先按它分块（一轮结束后才到，单独推一次）
        au().snapshot = ev.snapshot
        // 刚压缩完还不知道整个上下文多大：细分里的总占用就是压缩后的真实大小
        const fixed = compaction.measured(ev.snapshot.used, ev.snapshot.window || au().window)
        if (fixed) au().context = ev.snapshot.used
        ctx.changed(fixed)
        break
      }
      case 'tool_result':
        toolRows.result(ev)
        break
      case 'tool_delta':
        toolRows.delta(ev)
        break
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
      case 'compacting': {
        // CLI 自己开始压缩（自动压缩）：像后台命令一样先放一行转圈，压缩完成（compacted）再收掉
        const tool = compaction.startCli(au().context || undefined, toolStart)
        if (tool) (!cur || cur.text.trim() ? newMsg() : cur).tools.push(tool)
        break
      }
      case 'compacted': {
        // 压缩后会话里之前发过的规则只剩摘要：下一轮按完整提示重发（见 shared/prompt-delta.ts）
        compacted()
        // 当作一次工具调用放进回复里，不插一条系统消息把回复切成两段；压缩后的大小晚一点从 usage 补上
        const tool = compaction.done(ev, au())
        if (tool) (!cur || cur.text.trim() ? newMsg() : cur).tools.push(tool)
        ctx.changed(true)
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
      case 'wait': // 首包时间（cli-trace 算好的），会话栏显示：分得清是链路慢还是模型一直在想
        au().firstToken = addFirstToken(au().firstToken, ev.ms)
        break
      case 'error':
        errors.push(ev.message)
        break
      case 'notice': {
        // 重试、失败、面板工具没接上：写进日志，放进回复里当一行状态，不打断回复（见 notice-row.ts）
        // 重试用完了：前面那张「正在重试」收掉，失败原因看这一行
        if (ev.kind === 'retry_failed') settleRetryNotes(task.messages, t('重试用完了，没有恢复'), turnStart)
        const m = !cur || cur.text.trim() ? newMsg() : cur
        m.tools.push(noticeRow(ev, { task: task.id, step, cli: def.name }, quietBefore))
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
        watch.disarm()
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
        // 子对话开着「提问」：交给父对话，不在子对话里弹给用户（见 askViaParent）
        if (ev.kind === 'question' && task.parentTaskId && ctx.messageParent) return askViaParent(ev, ctx.messageParent)
        const id = ctx.newId()
        // 审批卡上点过「一直允许」的同类请求、权限是「跳过所有确认」这类一档：直接允许，留一行说明（ask-request.ts）
        const perm = def.permissions.find((p) => p.id === build.permission)
        if (autoAllowed(task, ev, { id, step, agentId }, perm?.autoAllow ? perm.label : '')) return ctx.changed(true)
        asked.push(id)
        replies.set(id, ev.reply)
        task.requests.push(requestOf(ev, { id, step, agentId }))
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
      REDIRECT_LIMITS,
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
  // 这次调用里的「等下一句」：用户的下一句直接交回这个进程，不用 --resume；新挂上的换下还挂着的旧的
  const userWait = userWaitSlot(task.id)
  /** 模型在这一轮里调用过 wait_user_message：结束时不用再保活一次 */
  let toolWaited = false
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
   * 停下等下一句 / 等子任务（fromTool：模型正在调 wait_user_message；否则是面板在这一轮结束后保活）：
   * 这段不用模型，让出 API 名额；拿到要处理的内容后先拿回名额再交给 CLI，
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
      openChanges(true)
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
          taskLog(task.id, helpers ? '等子任务结束' : '等下一句结束', {
            got: value === null ? 'none' : 'message',
            aborted: signal.aborted || undefined,
          })
          signal.removeEventListener('abort', onAbort)
          if (helpers) removeWaiter(task.id, w)
          else userWait.drop(w)
          if (helpers) waitingHelpers = false
          task.awaitingUser = false
          task.prewarming = false
          if (value === null && chat && !helpers) task.working = false
          if (!finished) ctx.changed(true)
          resolve(value)
        }
        const onAbort = () => done(null)
        const w: Waiter = {
          deliver: (msg, placed, recorded) => {
            taskLog(task.id, '消息交给等下一句的 CLI', { messageId: msg.id, recorded: recorded || undefined })
            // 只有用户自己的话才按「用户这次的消息」补状态；面板推的（后台命令结果、父对话传话）原样交
            fromUser = msg.role === 'user' && !msg.panel && !msg.peer
            // 用户发来第一句：预热结束，之后模型的输出正常记进对话
            prewarmMode = false
            if (!recorded) task.messages.push(msg)
            // 预热轮里撞上「强度被拒」时没法说（用户还没发话）：第一句到了再补
            tellNoEffort()
            // 继续执行：等待到此结束，从这一刻重新算执行时间
            resumeRun(task)
            // 收到用户消息，CLI 开始处理这一轮
            task.working = true
            // 之后的输出另起一条，排在用户消息后面
            cur = undefined
            const text = withAttachments(sourceHeader(msg) + msg.text, placed ?? msg.attachments ?? [])
            // 新的一轮从这里算起：空回合判定只看这条消息之后的输出
            turnMark = { from: mine.length, touched: touched.size, input: text }
            turnEnded = false
            // 等子任务时插进来的消息：子任务还在改文件，接着算；等下一句时来的是新要求，重新拍起点
            openChanges(helpers)
            arm(text)
            done(text)
          },
          cancel: () => done(null),
          // 等子任务时没有换 CLI 的问题：消息照样交给这个进程
          current: helpers ? () => true : stillCurrent,
        }
        // 上一次的还挂着（CLI 自己又跑了一轮再停回来）：旧的摘出等待表不再接消息，Promise 留到停止时随 signal 结束
        // 等子任务的等待照常挂；等下一句的换下还挂着的旧等待（CLI 自己又跑了一轮再停回来）
        const put = helpers ? { replaced: false, size: addWaiter(task.id, w) } : userWait.put(w)
        if (put.replaced) taskLog(task.id, '换下仍挂着的等下一句')
        taskLog(task.id, helpers ? '停下等子任务' : '停下等下一句', {
          cli: def.name,
          prewarm: prewarmMode || undefined,
          waiters: put.size,
          viewer: isWatched(task.id),
        })
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
  /**
   * 交给 CLI 的用户下一条消息（保活、模型自己调 wait_user_message 两条路一样）：以前原样交给 CLI，
   * 计划进度、子对话发来的消息、改动清单、授权变化都带不进去，也没有「## 用户这次的消息」标题。
   * 交给调用方按当前状态补上变了的段落（见 shared/prompt-delta.ts）；子任务结果、/命令照旧原样
   */
  const withState = async (text: string | null) => {
    // /bug 面板自己展开，原样交过去 Claude Code 会当成它自己的同名命令
    const bug = text !== null && fromUser ? bugSlash(text, task, !!call.orch?.coordinator) : undefined
    if (bug) return bug
    if (text === null || !fromUser || !call.nextPrompt || text.trim().startsWith('/')) return text
    return call.nextPrompt(text).catch((e) => {
      // 拼不出带状态的提示时退回原文照常交给 CLI（用户的话不能丢），但要留日志，不悄悄吞掉
      log.warn('task', '下一条消息没能补上当前状态，按原文交给 CLI', { task: task.id, error: (e as Error).message })
      return text
    })
  }
  // 模型主动调 wait_user_message 等下一句：这个工具是面板用 MCP 注进去的，只有能挂 MCP 的 CLI 才有。
  // 预热也走这里（预热提示让模型直接调它）：等到的用户消息同样按当前状态补段落
  const waitUser = canTake
    ? async () => {
        fromUser = false
        return withState(await waitNext(true))
      }
    : undefined
  // 面板保活：回复完这一轮不关进程，用户的下一条消息交给同一个进程开下一轮（不靠模型主动调等待工具）。
  // 只在对话页确实开着时这样做：没人看的时候留着一个 CLI 也没人会回来发消息
  const keepAlive = canWait
    ? async () => {
        if (!hasViewer(task.id)) return null
        // 这一轮什么都没收到：不保活，直接让它返回，交给收尾处报错
        if (emptyTurn()) return null
        // 连接断了（含 Claude Code 的输出中断判定，触发后它不自己重试）：不保活，交给收尾处报错并续接会话
        if (result && !result.ok && isNetError(result.error ?? '')) return null
        fromUser = false
        const text = await waitNext(false)
        // 拿到下一句就是新一轮开始了：上一轮模型有没有等过，跟新一轮无关
        if (text !== null) toolWaited = false
        return withState(text)
      }
    : undefined

  if (!prewarmMode) arm()
  // 总结下面的改动卡片从这里算起：用户的新要求重新拍起点，子任务、计划交回的结果接着上一圈的终点
  if (trackChanges && !prewarmMode) openChanges(!!call.carry)
  // 时长上限有两个来源：设置里的单步时限、计划带的时长上限。取小的那个，谁先到都停；
  // 停的时候要说清是哪个上限到的（见 effectiveTimeoutMinutes）
  const cap = effectiveTimeoutMinutes(settings.stepTimeoutMinutes, task.budgetMinutes ?? 0)
  // 插件给 Agent 的工具（ADR 0059）：开着的插件按这轮对话决定挂不挂，新会话的提示词里说明怎么用；令牌只在这一轮有效
  const plugins =
    def.mcp && !op
      ? await pluginRunTools(
          ctx,
          { agent, resume: !!resume, cwd, step, agentId },
          {
            // 插件的改文件类工具：执行前过工具前守卫（守卫在下面 hookOptions 里装到 call.orch 上，调用时才取），
            // 改了的文件和 CLI 自己的改文件工具一样记成这一轮的改动、登记归属
            guardEdit: async (tool, paths, input) => (await call.orch?.guardEdit?.(tool, paths, input)) ?? '',
            changed: (files) => {
              for (const f of files)
                fileEvents.track({ kind: 'edit', label: f, detail: '' }, { path: f, add: 0, del: 0 }, false)
            },
            // 插件的长任务交给面板的后台命令（插件框架改进 G1）：和 run_background 同一套监管，结果推回这个对话
            background: async (job) => {
              const orch = call.orch
              if (!orch?.canBackground) return { ok: false, info: '这个对话不能用后台命令：插件自己跑' }
              return orch.runBackground({
                command: String(job.command ?? ''),
                name:
                  String(job.name ?? '').trim() ||
                  String(job.command ?? '')
                    .split('\n')[0]
                    .slice(0, 40),
                cwd: String(job.cwd ?? ''),
                exclusive: job.exclusive === true,
                ...(Number(job.timeoutMinutes) > 0 && { timeoutMinutes: Number(job.timeoutMinutes) }),
              })
            },
          },
        )
      : undefined
  if (plugins?.hint && !resume) input = `${input}\n\n${plugins.hint}`
  if (chat)
    taskLog(task.id, '对话的 CLI 进程启动', {
      cli: def.name,
      model: model || undefined,
      resume: resume ? true : undefined,
      prewarm: prewarmMode || undefined,
      keepAlive: !!keepAlive,
    })
  // 新会话：和 CLI 同时探测项目里的远程 MCP，卡住的写一行警告（CLI 第一轮可能在等它握手）
  if (chat && !resume && !op && !prewarmMode)
    warnSlowMcp({
      task,
      cli: def.name,
      probe: def.mcpProbe,
      cwd,
      env,
      agentId,
      step,
      newId: ctx.newId,
      changed: () => ctx.changed(true),
    })
  // 压缩上下文：像后台命令一样，一开始就放一行转圈，压缩完成换成前后大小（不再插一行居中的「压缩上下文」）
  if (op?.kind === 'compact' && !prewarmMode) {
    const fresh = compaction.startOp(op, au().context || undefined, toolStart)
    if (fresh) newMsg().tools.push(fresh)
    ctx.changed(true)
  }
  // 钩子拦住、让它接着做时记一行「面板让它接着做」，之后的输出另起一条
  const hooks = await hookOptions({
    task,
    project,
    agent,
    agents: ctx.agents,
    cliId,
    cwd,
    call,
    mark: (reason) => {
      cur = undefined
      task.messages.push(hookMarker(reason, ctx.newId(), agentId, step))
      ctx.changed(true)
    },
  })
  const r = await invokeCli({
    mcp: plugins?.servers.length ? plugins.servers : undefined,
    cliId,
    command: cs.command,
    build,
    cwd,
    env,
    input,
    // 进程面板按这个归属：子对话、子任务、工作流都是同一个任务树上的进程
    owner: { taskId: task.id, rootTaskId: task.rootTaskId || task.id, title: task.title, step },
    signal: ctx.signal,
    // 0 表示不限制
    timeoutMs: cap.minutes ? cap.minutes * 60_000 : 0,
    // 环境性失败重试那一轮把请求超时放宽：高负载时 CLI 冷启动 + 桥接扩展加载会顶到默认的 15 秒
    requestTimeoutMs: envStalls ? envStallTimeout(cliId) : undefined,
    idle: idleMs
      ? {
          ms: idleMs,
          // 在等用户确认、回答或下一句时 CLI 本来就没有输出，不算卡住（推送授权卡是面板替 ask_push 弹的，不在 asked 里）
          // 排队等 API 名额时也一样
          busy: () =>
            task.awaitingUser ||
            waitingHelpers ||
            !!(call.step ? call.step.apiWait : task.apiWait) ||
            inToolWait.has(slotKey(task.id, step)) ||
            task.requests.some((x) => asked.includes(x.id) || (!step && x.purpose === 'push')),
          onWarn: () => {
            task.messages.push(idleWarning({ id: ctx.newId(), agentId, step, cli: def.name, idleMinutes }))
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
    // 钩子（ADR 0049，见 server/hooks/dispatch.ts）：预热也装，预热的进程之后要处理用户消息；没收到消息前 before-end.ts 放行
    ...hooks,
  }).finally(() => {
    finished = true
    drafting.clear()
    if (chat) taskLog(task.id, '对话的 CLI 进程结束', { cli: def.name, aborted: ctx.signal.aborted || undefined })
    plugins?.close()
    watch.stop()
    clearTimeout(redirectTimer)
    for (const x of [...toolStart.keys()]) endTool(x)
    // CLI 说开始压缩了，进程结束都没等到压缩完成：不能显示得像压缩成功了
    compaction.processEnd()
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
    for (const id of asked) replies.delete(id) // 进程结束了（完成、停止、超时）：还没回答的请求作废，并写明作废了哪些
    if (dropAsked(task, asked, { id: ctx.newId(), agentId, step })) ctx.changed(true)
    if (task.usage.agents[agentId]) task.usage.agents[agentId].tps = 0
  })

  for (const m of mine) if (m.text && m.role === 'agent') texts.push(m.text)
  // 空回合兜底只看最后一轮：保活时前几轮的回复不能把最后一条没人答的消息盖住
  const turnTexts = turnMsgs().flatMap((m) => (m.text && m.role === 'agent' ? [m.text] : []))
  // 记下这一轮在会话里的位置，分叉、撤回时让 CLI 从这里截断
  if (asker && task.sessions[sessionKey])
    asker.turn = { session: task.sessions[sessionKey], id: turn.id, end: turn.end }
  // 被停下、出错的一轮没走到 endTurn：改过的文件照样记上，用户才能撤销做了一半的改动。
  // 等快照拍完再落盘，免得卡片写在落盘之后丢了
  if (!prewarmMode) closeChanges()
  if (trackChanges) await settleTurnChanges(task.id)
  if (ctx.isGit) {
    const changes = await taskChanges(cwd, task, touched).catch(() => null)
    if (changes) {
      // 只在跑的节点的改动也会出现在差值里：只算 CLI 亲自报告的文件改动（Write、Edit 报的 file 事件）。
      // 没报告过文件的节点（只读调研、用命令写的）不加归因：差值里可能是并行子对话的改动，算给它就变成了它的改动
      const mine = ownedChanges(changesSince(before, changes), touched)
      if (owner) mergeChanges((owner.changes ??= []), mine)
      task.changes = changes
    }
  }
  // 项目外写过的文件：任何模式都要记，界面上单独一组列出（没有 git 快照，只能查看）
  trackOutside(task, cwd, touched)
  ctx.changed(true)

  // 进程结束的情况都记一笔：退出码、为什么被停、最后的错误输出，排查问题时对得上页面上的报错
  if (r.killed || r.spawnError || r.code !== 0 || result?.ok === false)
    log.warn('agent', `${def.name} 进程结束`, {
      task: task.id,
      step,
      code: r.code,
      signal: r.exitSignal,
      killed: r.killed,
      spawnError: r.spawnError,
      result: result?.error,
      errors: errors.join('\n'),
      stderr: r.stderr.trim().split('\n').slice(-20).join('\n'),
    })
  // 起不来、卡住被停、停止、超时、长时间没有输出：直接交回（判定和报错的写法在 exit-result.ts）
  const early = exitResult({
    r,
    def,
    stalled: stallAc.signal.aborted && !outerSignal.aborted,
    aborted: ctx.signal.aborted,
    cap,
    errors,
    idleMinutes,
  })
  if (early) return early
  const failed = result ? !result.ok : r.code !== 0
  if (failed) {
    const detail = [result?.error, ...errors, stderrTail(r.stderr, 6, def.stderrNoise)].filter(Boolean).join('\n')
    // 自定义接口的模型不支持调整思考强度：记住，去掉强度再跑一次（CLI 启动时就退出，没有实际输出）
    if (effort && !retried && EFFORT_REJECTED.test(detail)) {
      markNoEffort(cliId, model)
      log.warn('agent', `${def.name} 的模型 ${model} 不支持设置思考强度，去掉后重试`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      recoveryNote(noEffortRetryText(model, effort, detail))
      // 说过了，重跑那次不再补「这一轮没有传」；预热轮没说，留给第一句到了再补
      if (!prewarmMode) firstNoEffortTell(noEffortKey)
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
    // 丢会话重开前留一行（原因、带没带上之前的对话、原始报错）。之前断流续接写的红卡也在这里收口：
    // 会话都没了，后面是新会话重新执行，不能等成功后写成「从中断的地方继续了」
    const restartNote = (why: string, carried: boolean) => {
      settleNetNotes(netNotes, true)
      recoveryNote(restartNoteText(why, { chat, carried, detail }))
    }
    // 会话找不到时（例如 CLI 清理了历史），丢掉会话重新开始一次
    if (resume && !prewarm && !retried && SESSION_NOT_FOUND.test(detail)) {
      delete task.sessions[sessionKey]
      delete task.sessionDirs[sessionKey]
      const carry = carryForRestart()
      log.warn('agent', `${def.name} 的会话找不到了，丢掉后重开`, { task: task.id, step, detail: detail.slice(0, 500) })
      restartNote(t('{cli} 找不到原来的会话（可能被 CLI 清理了）', { cli: def.name }), !!carry)
      // 新会话没有之前的上下文：节点用完整提示，对话把之前的对话裁剪后带上，不然模型突然全忘了。
      // 断流续接写的红卡已经在 restartNote 里收口，不再往下传（netRetries 照传：续接次数前后合计）
      return runAgent(
        ctx,
        { ...call, prompt: call.fresh ?? call.prompt },
        true,
        netRetries,
        carry,
        [],
        contextNotes,
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
      const carry = carryForRestart()
      restartNote(
        t('{cli} 的会话存在别的项目目录里，面板没法回答它「要不要分叉到当前目录」', { cli: def.name }),
        !!carry,
      )
      return runAgent(
        ctx,
        { ...call, prompt: call.fresh ?? call.prompt },
        true,
        netRetries,
        carry,
        [],
        contextNotes,
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
      // 按预算裁剪：原来带的是不设上限的整段，重开那次已经算重试过，历史超窗口时不会再降级，直接失败
      const carry = carryForRestart()
      log.warn('agent', `${def.name} 的会话和当前模型不兼容，丢掉旧会话重开`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      restartNote(t('模型接口拒绝了 {cli} 这个会话的历史（常见于中途换了模型或网关）', { cli: def.name }), !!carry)
      return runAgent(
        ctx,
        chat ? call : { ...call, prompt: call.fresh ?? call.prompt },
        true,
        netRetries,
        carry,
        [],
        contextNotes,
        envStalls,
        envStallNotes,
      )
    }
    const hints = failureHints(detail, def)
    // 先写进程怎么结束的（退出码、被外部杀掉时的信号）：被 kill -9 时退出码是 null，只看 stderr 会误判原因
    const how = exitReason(r)
    const head = how
      ? t('{cli} 执行失败（{reason}）：', { cli: def.name, reason: how })
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
          // 原来的提示存进 fresh：续接时原会话没了（会话找不到等）会改用 fresh 开新会话，
          // 不存的话发进空会话的是这句「从中断的地方继续」，新会话根本不知道要做什么
          fresh: call.fresh ?? call.prompt,
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
    // 自动压缩抖动：CLI 压缩完马上又被一次工具输出填满、放弃了这一轮。多半是一次读进来太多，
    // 在原会话里续一轮、让模型分段读取常常就过去了；只续一次，续之前在对话里写一行警告（不悄悄重试）
    if (
      shouldRetryThrash({
        detail,
        pattern: def.compactThrash,
        session: !!session,
        prewarm,
        compact: op?.kind === 'compact',
        aborted: ctx.signal.aborted,
        tried: contextNotes.some((n) => n.thrash),
      })
    ) {
      const note = thrashNote({ id: ctx.newId(), agentId, step, message, raw })
      task.messages.push(note)
      log.warn('agent', `${def.name} 自动压缩抖动，在原会话里续一轮`, {
        task: task.id,
        step,
        detail: detail.slice(0, 500),
      })
      ctx.changed(true)
      return runAgent(
        ctx,
        // 原来的提示存进 fresh：续接时原会话没了会改用它开新会话（和断流续接一样）
        { ...call, fresh: call.fresh ?? call.prompt, prompt: THRASH_RETRY_PROMPT },
        retried,
        netRetries,
        '',
        netNotes,
        [...contextNotes, { msg: note, base: message, thrash: true }],
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
        const summary = overflowCompact({
          task,
          sessionKey,
          clipped: clippedTranscript(task, task.messages.length, carryBudget()),
          usage: au(),
          tracker: compaction,
          msg: (text) => ({
            id: ctx.newId(),
            role: 'system',
            agentId,
            step,
            text,
            tools: [],
            at: new Date().toISOString(),
          }),
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
        // 和丢会话重开同一份裁剪（审查操作也走这里，所以不用 carryForRestart 的「操作不带」）
        const carry = restartCarry(task, carryUpto(), carryBudget())
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
      contextNotes.some((n) => n.thrash) ? t('已在原会话里续过一轮，仍然失败。') : '',
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
  if (op?.kind === 'compact') compacted()
  // 不能压缩会话的 CLI：摘要写好了，下一轮开新会话带上它
  if (op?.kind === 'compact' && def.compact === 'summary') {
    task.rewind = { session: '', through: null, latest: false, summary: done.text }
    delete task.sessions[sessionKey]
    delete task.sessionDirs[sessionKey]
    au().context = 0
    if (!compaction.settle(t('摘要写好了，下一轮开新会话带上')))
      sysMsg(t('已压缩上下文：下一轮会开新的会话，带上这份摘要'))
  } else if (op?.kind === 'compact') compaction.finishOp(au())
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
    // 原因写在压缩那一行里（点开看），不另插一行居中的说明
    const auto = {
      kind: 'compact' as const,
      reason: t('上下文占用达到 {n}%，自动压缩', { n: Math.round((u.context / u.window) * 100) }),
    }
    // 压缩也是这一轮里的一次完整调用：环境性重试的计数和留痕要接着传，否则重置后可能再重试一次
    const c = await runAgent(
      ctx,
      { ...call, op: auto },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envStalls,
      envStallNotes,
    )
    settleCompactRow(auto, c)
    if (!c.ok && !c.stopped) sysMsg(t('自动压缩失败：{error}', { error: c.error }), true, makeAlert('error', c.error))
  }
  return done
}
