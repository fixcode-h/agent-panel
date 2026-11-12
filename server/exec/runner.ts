import { noteCommandTime } from '../command-times.ts'
import { turnInfo } from './turn-info.ts'

import { stat } from 'node:fs/promises'
import { aliasAgent, type AgentUsage, type Task, type TaskMessage, type ToolUse } from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { hookMarker } from '../../shared/hooks.ts'
import { hookOptions } from '../hooks/dispatch.ts'
import { addNoteTaker, type NoteTaker } from './delivery.ts'

import { agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import {
  changesSince,
  mergeChanges,
  ownedChanges,
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
import { effortRejected } from '../models.ts'
import { type AgentCall, type AgentResult } from '../../shared/engine.ts'

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
  noEffortSkippedText,
  settleContextNotes,
  settleNetNotes,
  settleRetryNotes,
  type ContextNote,
  type NetNote,
} from './recovery.ts'
export { SESSION_NOT_FOUND, settleContextNotes, settleNetNotes, settleRetryNotes, type ContextNote, type NetNote }
import { awaitingCompact, CompactTracker, settleCompactRow } from './compaction.ts'
import { composeRole, includedAgents, nodeAgentRun } from '../../shared/agent-role.ts'
import { fillSkills } from '../../shared/expose.ts'

import { ensureBundled, sharedRoot } from '../bundled-skills.ts'
import { withSkillDir } from '../../shared/skill-guide.ts'

import { invokeCli, type CliControl } from './invoke.ts'

import { REDIRECT_LIMITS, REDIRECT_NOTE, redirectWait } from './redirect.ts'
import { t } from '../../shared/i18n.ts'

import { promptLangRules, promptUserNameRules } from '../../shared/prompt-lang.ts'
import { ensurePromptLangMod } from './prompt-lang-mod.ts'
import { log } from '../log.ts'
import { taskLog } from '../task-log.ts'

import { turnRole } from '../../shared/conv-mode.ts'
import { pluginRunTools } from './plugin-run.ts'
import { seenWhileWatched } from '../presence.ts'
import { ApiSlot } from '../api-slots.ts'
import { beginTurnChanges, endTurnChanges, settleTurnChanges, summaryMessage } from '../turn-changes.ts'
import { noteEdit } from '../turn-owners.ts'
import { canKeepAlive, envStallTimeout, forgetPromptSent, silentTurn } from './retry-policy.ts'
import { steerNote, steers } from './steering.ts'
import { anySignal, apiSlots, callApi, inToolWait, slotKey, takeApiSlot } from './api-gate.ts'
import { speedMeter } from './speed-meter.ts'
import type { RealContext } from './real-context.ts'
import { createStallWatch } from './stall-watch.ts'
import { warnSlowMcp } from './mcp-probe.ts'
import { createFileEvents } from './file-events.ts'
import { continuesOutput } from './event-kinds.ts'
import { createDrafting } from './drafting.ts'
import { createToolRows } from './tool-rows.ts'
import { makeStillCurrent } from './still-current.ts'
import { newRunState } from './run-state.ts'
import { createApply } from './run-events.ts'
import { createWaiting } from './run-wait.ts'
import { afterProcess, finishTurn } from './run-finish.ts'
import { freshRetry, recoverFailure, type RetryState } from './run-recover.ts'
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
  /** 一串自动重跑之间接着传的记录（见 run-recover.ts） */
  rs: RetryState = freshRetry(),
): Promise<AgentResult> {
  const { retried, retryCarry, envStalls } = rs
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
  // 这次调用各阶段共享的可变状态，谁读谁写见 run-state.ts。预热期间的输出不记进对话；用户发来第一句后开始正常记
  const st = newRunState(prewarm, call.prompt)
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
    if (st.prewarmMode && !evenPrewarm) return
    task.messages.push(systemNote(ctx.newId(), agentId, step, text))
    ctx.changed(true)
  }
  const noEffortKey = `${task.id}\n${cliId}\n${model}`
  // 选了思考强度、这个模型却因为之前（别的对话、预热轮里）被拒过而不传了：每个对话第一次碰到时说一次
  const tellNoEffort = () => {
    if (st.prewarmMode || !requested || effort || !effortRejected(cliId, model)) return
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
  const turnMsgs = () => mine.slice(st.turnMark.from)
  const turnTools = () => turnMsgs().reduce((n, m) => n + m.tools.length, 0)
  // 这一轮改了哪些文件，记在这一轮的总结上（见 server/turn-changes.ts）：只有对话自己的轮次记，子任务、节点不记
  const trackChanges = chat && !op && ctx.isGit
  const openChanges = (carry: boolean) => {
    if (!trackChanges) return
    st.changesOpen = true
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
    if (!st.changesOpen) return
    st.changesOpen = false
    // 这一刻的消息就是这一轮的：快照要一会儿，等它的时候下一轮可能已经开始往 mine 里加了
    const msgs = turnMsgs()
    void endTurnChanges(task.id, (c) => {
      const m = summaryMessage(msgs)
      if (!m) return
      m.turnChanges = c
      ctx.changed(true)
    })
  }
  const texts: string[] = []
  const errors: string[] = []
  const newMsg = () => {
    st.cur = {
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
    task.messages.push(st.cur)
    mine.push(st.cur)
    return st.cur
  }

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
  const refreshChanges = () => {
    if (!ctx.isGit || st.gitTimer || st.gitBusy) return
    st.gitTimer = setTimeout(async () => {
      st.gitTimer = undefined
      st.gitBusy = true
      const changes = await taskChanges(cwd, task, touched).catch(() => null)
      st.gitBusy = false
      // 项目外的写文件不在 git 差异里：和项目内的一起边跑边更新
      const outside = st.finished ? 0 : trackOutside(task, cwd, touched)
      if (!st.finished && (changes || outside)) {
        if (changes) task.changes = changes
        ctx.changed()
      }
    }, 1500)
  }
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
    if (st.prewarmMode || op || ctx.signal.aborted) return false
    // texts 要等进程结束后才汇总，这里直接用这次调用的消息，result 到达时就能判断
    const texts = turnMsgs()
      .filter((m) => m.role === 'agent')
      .map((m) => m.text)
    return silentTurn({ texts, tools: turnTools(), changed: touched.size - st.turnMark.touched })
  }
  /**
   * 这一轮结束的回调只发一次：CLI 的 result 和「回复完停在等下一句」都会走到 markTurnDone，
   * 两处都记会让子对话把同一个状态重复上报父对话（父对话里一条汇报显示两遍）。
   * 用户发来下一条消息、或者子任务的结果交回让 CLI 接着做，都算新的一段（见 listen 和 waitNext）。
   */
  const endTurn = () => {
    if (st.turnEnded) return
    st.turnEnded = true
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
        st.waitingHelpers ||
        (helperWatch ? call.step?.apiWait : task.apiWait) ||
        toolStart.size ||
        task.requests.some((x) => asked.includes(x.id))
      ),
    off: () => st.finished || st.prewarmMode,
    newId: ctx.newId,
    changed: () => ctx.changed(true),
    kill: () => stallAc.abort('stalled'),
  })
  const { arm } = watch
  const drafting = createDrafting(task, () => ctx.changed())
  /**
   * 补充排在正在执行的命令后面（Pi 要等这一批工具跑完才取）：命令跑了一会儿还没完（例如 sleep 等 CI），
   * 用户就一直等不到回应。超过阈值就停下这条命令，让 CLI 马上处理补充；
   * 只读命令等它自己跑完（这批工具结束时 CLI 就会取补充），卡住了才按更长的阈值停
   */
  const checkRedirect = () => {
    clearTimeout(st.redirectTimer)
    st.redirectTimer = undefined
    const c = st.control
    if (!st.steerPending || st.finished || !c?.redirect) return
    // 只等命令：读文件、改文件很快就完；面板自己的工具（等子任务这些）另有办法接用户的消息
    const wait = redirectWait(
      [...toolStart].map(([x, at]) => ({ kind: x.kind, label: x.label, startedAt: at })),
      Date.now(),
      REDIRECT_LIMITS,
    )
    if (wait === undefined) return
    if (wait > 0) {
      st.redirectTimer = setTimeout(checkRedirect, wait)
      st.redirectTimer.unref?.()
      return
    }
    void c
      .redirect(REDIRECT_NOTE)
      .catch((e: Error) => log.warn('task', '停下命令处理补充失败', { task: task.id, error: e.message }))
  }
  const asked: string[] = []
  const apply = createApply({
    ctx,
    task,
    st,
    def,
    cliId,
    model,
    entries,
    sessionKey,
    cwd,
    owner,
    step,
    agentId,
    chat,
    op,
    turnStart,
    permission: build.permission,
    watch,
    drafting,
    meter,
    compaction,
    toolRows,
    fileEvents,
    toolStart,
    turn,
    errors,
    asked,
    newMsg,
    streamed,
    au,
    windowFor,
    compacted,
    refreshChanges,
    checkRedirect,
    endTool,
    emptyTurn,
    endTurn,
    turnTools,
  })
  const register = (c: CliControl) => {
    st.control = c
    st.steerer = {
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
          st.steerPending = true
          checkRedirect()
        } else st.cutAfter = true
        ctx.changed(true)
      },
    }
    ;(steers.get(task.id) ?? steers.set(task.id, new Set()).get(task.id)!).add(st.steerer)
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
        st.cur = undefined
        ctx.changed(true)
        return mine.map((m) =>
          steerNote(withAttachments(m.text, m.attachments ?? []), task.mode === 'chat', m.peer?.rel === 'parent'),
        )
      },
    }
    addNoteTaker(task.id, taker)
  }
  const { waitUser, keepAlive } = createWaiting({
    ctx,
    call,
    task,
    st,
    def,
    step,
    chat,
    op,
    orch,
    canTake: !!canTake,
    canWait,
    mine,
    touched,
    pendingNotes,
    arm,
    emptyTurn,
    endTurn,
    openChanges,
    stillCurrent,
    tellNoEffort,
  })

  if (!st.prewarmMode) arm()
  // 总结下面的改动卡片从这里算起：用户的新要求重新拍起点，子任务、计划交回的结果接着上一圈的终点
  if (trackChanges && !st.prewarmMode) openChanges(!!call.carry)
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
      prewarm: st.prewarmMode || undefined,
      keepAlive: !!keepAlive,
    })
  // 新会话：和 CLI 同时探测项目里的远程 MCP，卡住的写一行警告（CLI 第一轮可能在等它握手）
  if (chat && !resume && !op && !st.prewarmMode)
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
  if (op?.kind === 'compact' && !st.prewarmMode) {
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
      st.cur = undefined
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
            st.waitingHelpers ||
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
    waited: () => st.toolWaited,
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
  }).finally(() =>
    afterProcess({
      ctx,
      task,
      st,
      def,
      step,
      agentId,
      chat,
      drafting,
      watch,
      meter,
      compaction,
      plugins,
      taker,
      toolStart,
      pendingNotes,
      steered,
      asked,
      endTool,
      turnMsgs,
    }),
  )

  for (const m of mine) if (m.text && m.role === 'agent') texts.push(m.text)
  // 空回合兜底只看最后一轮：保活时前几轮的回复不能把最后一条没人答的消息盖住
  const turnTexts = turnMsgs().flatMap((m) => (m.text && m.role === 'agent' ? [m.text] : []))
  // 记下这一轮在会话里的位置，分叉、撤回时让 CLI 从这里截断
  if (asker && task.sessions[sessionKey])
    asker.turn = { session: task.sessions[sessionKey], id: turn.id, end: turn.end }
  // 被停下、出错的一轮没走到 endTurn：改过的文件照样记上，用户才能撤销做了一半的改动。
  // 等快照拍完再落盘，免得卡片写在落盘之后丢了
  if (!st.prewarmMode) closeChanges()
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
  if (r.killed || r.spawnError || r.code !== 0 || st.result?.ok === false)
    log.warn('agent', `${def.name} 进程结束`, {
      task: task.id,
      step,
      code: r.code,
      signal: r.exitSignal,
      killed: r.killed,
      spawnError: r.spawnError,
      result: st.result?.error,
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
  const failed = st.result ? !st.result.ok : r.code !== 0
  if (failed)
    return recoverFailure({
      ctx,
      call,
      task,
      def,
      cliId,
      model,
      effort,
      sessionKey,
      step,
      agentId,
      cwd,
      chat,
      op,
      prewarm,
      resume: !!resume,
      prewarmMode: st.prewarmMode,
      result: st.result,
      r,
      errors,
      rs,
      noEffortKey,
      compaction,
      au,
      recoveryNote,
      carryForRestart,
      carryUpto,
      carryBudget,
      rerun: (next, nextRs) => runAgent(ctx, next, nextRs),
    })
  return finishTurn({
    ctx,
    call,
    task,
    st,
    def,
    step,
    agentId,
    sessionKey,
    chat,
    op,
    prewarm,
    pct,
    rewind,
    rs,
    texts,
    errors,
    touched,
    turnTexts,
    turnTools,
    compaction,
    compacted,
    au,
    rerun: (next, nextRs) => runAgent(ctx, next, nextRs),
  })
}
