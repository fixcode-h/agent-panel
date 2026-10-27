/** 新建任务的初始数据；真实执行和在线演示共用 */
import {
  type AskKind,
  type Attachment,
  type DeliveryHow,
  type FileChange,
  type NewTaskInput,
  type StepUsage,
  type StopReason,
  type Task,
  type TaskData,
  type TaskMessage,
  type TaskRequest,
  type TaskStep,
  type TaskTurn,
  type ToolUse,
  type TurnEnd,
  type Workflow,
} from './schema.ts'
import { currentRun, inRun, planTask } from './flow.ts'
import { getLang, t } from './i18n.ts'
import { activePlan, openPlan, openWork, planProgress } from './plan.ts'
import { attachChip, chipMarker, isAbsolutePath, quoteBlock } from './composer.ts'

export function taskTitle(prompt: string) {
  // 标题里不放附件引用，用户写的第一句话才是标题；只发了附件时仍用原文
  const raw = prompt.trim().split('\n')[0]
  const line =
    raw
      .replace(/\[(?:图片|文件|引用):[^\]]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || raw
  return line.length > 32 ? line.slice(0, 32) + '…' : line
}

/**
 * 附件在文字里的标记：输入框里的图片、文件、引用卡片都是这样存的，交给 CLI 前换成路径或引用块（见 shared/composer.ts）
 */
export function attachmentRef(a: Pick<Attachment, 'name' | 'mime' | 'quote'>) {
  return chipMarker(attachChip(a), a.name)
}

/**
 * 附件列表里每一行的读法：图片拷进了对话目录、给的是相对路径；其它是本机绝对路径。
 * 两种形态都有，按附件本身判（attachChip），不能只看路径是不是绝对：
 * 项目对话里粘贴进来的项目内文件会被 placeAttachments 换成相对路径，但它不是图片。
 */
function attachReadNote(a: Pick<Attachment, 'name' | 'mime' | 'quote' | 'path'>) {
  const image = attachChip(a) === 'image'
  if (!isAbsolutePath(a.path)) return image ? '对话目录里的图片，相对路径' : '对话目录里的文件，相对路径'
  return image ? '图片，本机绝对路径' : '本机绝对路径'
}

/**
 * 交给 Agent 的要求：文字里引用到的附件在原来的位置换成路径，引用卡片换成引用块；
 * 没引用到的引用放在最前面，文件仍然列在后面。
 * CLI 用自己的读文件工具去读（Claude Code、Codex 都能直接看图片）
 */
export function withAttachments(prompt: string, attachments: Attachment[] | undefined) {
  if (!attachments?.length) return prompt
  let text = prompt
  const used = new Set<Attachment>()
  // 名字长的先换：一个名字是另一个的前缀时不会换错
  for (const a of [...attachments].sort((x, y) => y.name.length - x.name.length)) {
    const ref = attachmentRef(a)
    if (!text.includes(ref)) continue
    // 原位只换路径、不拼读法标注：用户句子里的路径保持原样，没被引用的附件在末尾列表里带标注（见 attachReadNote）
    text = text.split(ref).join(a.quote !== undefined ? `\n${quoteBlock(a.quote)}` : a.path)
    used.add(a)
  }
  const quotes = attachments.filter((a) => !used.has(a) && a.quote !== undefined)
  if (quotes.length) text = quotes.map((a) => quoteBlock(a.quote ?? '')).join('') + text
  text = text.replace(/^\n+/, '')
  const rest = attachments.filter((a) => !used.has(a) && a.quote === undefined)
  if (!rest.length) return text
  const list = rest.map((a) => `- ${a.name}：${a.path}（${attachReadNote(a)}）`).join('\n')
  return `${text}\n\n## 附件\n用户附上了这些文件，按标注的方式读取：\n${list}`
}

/** 新建任务的初始数据 */
export function newTask(
  input: NewTaskInput,
  workflow: Workflow | undefined,
  now: string,
  id: string,
  /** 存进任务的工作流（连同引用的其他工作流），见 workflowClosure */
  snapshot: Workflow[] = workflow ? [workflow] : [],
  /** 项目里定的技能槽取值（见 shared/expose.ts 的 exposeSlots） */
  skillSlots: Record<string, string> = {},
): TaskData {
  const wf = input.mode === 'workflow' ? workflow : undefined
  return {
    projectId: input.projectId,
    title: taskTitle(input.prompt),
    // 子对话的标题是父对话起的，不用再换
    autoTitle: !input.parentTaskId,
    mode: input.mode,
    parentTaskId: input.parentTaskId ?? '',
    rootTaskId: input.rootTaskId ?? '',
    summary: '',
    rules: [],
    goal: '',
    wantsWorktree: false,
    inbox: [],
    workflowId: input.mode === 'workflow' ? (workflow?.id ?? '') : '',
    agentId: input.mode === 'chat' ? input.agentId : '',
    // 默认 Agent 和不用 Agent 角色的对话（agentId 为空）都能在对话时选 CLI 和模型；其他 Agent 用自己配置的
    cli: input.mode === 'chat' && canPickRun(input.agentId) ? (input.cli ?? '') : '',
    model: input.mode === 'chat' && canPickRun(input.agentId) ? (input.model ?? '') : '',
    effort: input.mode === 'chat' && canPickRun(input.agentId) ? (input.effort ?? '') : '',
    askUser: input.askUser ?? false,
    // 父对话的「子对话也提问」：之后新建的子对话默认问不问（设置里的全局默认由创建时填进来）
    childAskUser: input.childAskUser ?? true,
    ...(input.analysis && { analysis: input.analysis }),
    params: input.mode === 'chat' ? (input.params ?? {}) : {},
    status: 'running',
    runMs: 0,
    runStartedAt: now,
    waitMs: 0,
    waitStartedAt: '',
    idleWaitMs: 0,
    idleWaitAt: '',
    turns: [],
    ...(input.mode === 'workflow' ? planTask(workflow) : { steps: [] }),
    messages: [
      {
        id,
        role: 'user',
        agentId: '',
        step: '',
        text: input.prompt.trim(),
        tools: [],
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        at: now,
      },
    ],
    changes: [],
    simulated: false,
    sessions: {},
    sessionDirs: {},
    command: [],
    usage: { agents: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    todos: [],
    plans: [],
    baseline: {},
    baseRef: '',
    workflows: wf ? snapshot : [],
    runs: [],
    skillSlots: wf ? skillSlots : {},
    testSteps: [],
    testRuns: [],
    platform: '',
    // 计划带的执行上限：之后改计划不影响这个已经启动的对话
    budgetTokens: input.budgetTokens ?? 0,
    budgetMinutes: input.budgetMinutes ?? 0,
    workflowName: wf?.name ?? '',
    runSeq: 0,
    requests: [],
    working: false,
    turnDoneAt: '',
    turnSeenAt: '',
    awaitingUser: false,
    prewarming: false,
    worktree: null,
  }
}

/** 开始一轮执行：记下开始时间，结束时累加进 runMs */
export function beginRun(task: { runStartedAt: string }, now = new Date()) {
  task.runStartedAt = now.toISOString()
}

type Pausable = {
  runStartedAt: string
  runMs: number
  waitMs: number
  waitStartedAt: string
  idleWaitMs: number
  idleWaitAt: string
}

/**
 * 执行中停在等待上（答完了，等用户下一条消息）：先把已经跑的执行时间结算进 runMs，
 * 停下的这一刻开始算「等下一句」（idleWaitMs），之后的空闲不再算执行。
 * keepAlive 让一次 CLI 调用一直不返回，不在这里断开的话整段空闲都会被算成执行时间。
 *
 * 「等下一句」和「等用户确认 / 提问」（waitMs，那段同时算在执行里）分开记：
 * 混在一个数里时报告会写出「执行 8m（其中等你处理 23h55m）」这种装不下的数，也会和「空闲」重复计时
 */
export function pauseRun(task: Pausable, now = Date.now(), opts?: { idle?: boolean }) {
  if (!task.runStartedAt) return
  task.runMs += Math.max(0, now - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
  // 等子对话时（idle: false）不记「等用户回下一句」：这段时间父对话没在跑，也不是在等用户；
  // 它归到「本任务没在跑」的那一段里，由报告的「子对话占用」扣出来，不然会同时算成等待和占用
  if (opts?.idle === false) return
  if (!task.idleWaitAt) task.idleWaitAt = new Date(now).toISOString()
}

/** 等到了（用户回答 / 发来下一句）：两种等待各自结算，从这一刻继续算执行 */
export function resumeRun(task: Pausable, now = Date.now()) {
  if (task.waitStartedAt) {
    task.waitMs = (task.waitMs ?? 0) + Math.max(0, now - Date.parse(task.waitStartedAt))
    task.waitStartedAt = ''
  }
  if (task.idleWaitAt) {
    task.idleWaitMs = (task.idleWaitMs ?? 0) + Math.max(0, now - Date.parse(task.idleWaitAt))
    task.idleWaitAt = ''
  }
  if (!task.runStartedAt) task.runStartedAt = new Date(now).toISOString()
}

/**
 * 答完后等用户下一句的总时间（毫秒）：不算执行，也不算「等你确认/提问」。
 * 只有还在跑的任务（status 为 running 或没给）才把正在等的那段算到 now；
 * 已经停下的任务留着 idleWaitAt 只是没清掉，再按 now 算会让跨度和等待时间随查看时间一直涨
 */
export function idleWaitDuration(
  o: Partial<{ idleWaitMs: number; idleWaitAt: string; status: string }>,
  now = Date.now(),
) {
  const live = !!o.idleWaitAt && (o.status === undefined || o.status === 'running')
  return (o.idleWaitMs ?? 0) + (live ? Math.max(0, now - Date.parse(o.idleWaitAt!)) : 0)
}

export function endRun(
  task: TurnHost & {
    runMs: number
    runStartedAt: string
    waitMs: number
    waitStartedAt: string
    idleWaitMs: number
    idleWaitAt: string
    steps: Timed[]
    stopReason?: StopReason
  },
  now = new Date(),
) {
  if (task.runStartedAt) task.runMs += Math.max(0, now.getTime() - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
  // 停下时还挂着的请求随这一轮结束，等待也到此为止（包含停在等待工具上的那段）
  task.waitMs = waitDuration(task, now.getTime())
  task.waitStartedAt = ''
  // 等下一句的那段也结算掉：这里不看 status——收尾时 status 可能已经改成 done/stopped，
  // 按 status 判 live 会把整段等待丢掉；留着开始时间，下次结算还会把之后的时间算进去
  task.idleWaitMs =
    (task.idleWaitMs ?? 0) + (task.idleWaitAt ? Math.max(0, now.getTime() - Date.parse(task.idleWaitAt)) : 0)
  task.idleWaitAt = ''
  for (const o of task.steps) closeWait(o, now.getTime())
  // 还挂着的轮次照现在的停止原因收掉：面板重启、父对话收尾、用户暂停要能分开说
  for (const turn of task.turns ?? [])
    if (turn.status === 'running') endTurn(task, turn, 'stopped', now.getTime(), task.stopReason)
}

type TurnHost = Timed & {
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
  turns: TaskTurn[]
}

/** 开始一轮追加要求 / 对话：记下开始时间和这时的累计用量 */
export function beginTurn(task: TurnHost, id: string, prompt: string, agentId: string, now = Date.now()) {
  const line = prompt.trim().split('\n')[0] ?? ''
  const turn: TaskTurn = {
    id,
    title: line.length > 60 ? line.slice(0, 60) + '…' : line,
    agentId,
    status: 'running',
    startedAt: new Date(now).toISOString(),
    endedAt: '',
    from: {
      inputTokens: task.usage.inputTokens,
      outputTokens: task.usage.outputTokens,
      cacheReadTokens: task.usage.cacheReadTokens ?? 0,
      waitMs: waitDuration(task, now),
    },
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    waitMs: 0,
  }
  ;(task.turns ??= []).push(turn)
  return turn
}

/** 一轮的用量和等待：结束了用记下的，执行中按现在的累计减去开始时的 */
export function turnStats(task: TurnHost, turn: TaskTurn, now = Date.now()) {
  if (turn.status !== 'running') return turn
  return {
    inputTokens: Math.max(0, task.usage.inputTokens - turn.from.inputTokens),
    outputTokens: Math.max(0, task.usage.outputTokens - turn.from.outputTokens),
    cacheReadTokens: Math.max(0, (task.usage.cacheReadTokens ?? 0) - turn.from.cacheReadTokens),
    waitMs: Math.max(0, waitDuration(task, now) - turn.from.waitMs),
  }
}

export function endTurn(
  task: TurnHost,
  turn: TaskTurn,
  status: TaskTurn['status'],
  now = Date.now(),
  reason?: StopReason,
) {
  if (turn.status !== 'running') return
  const end = turnEndOf(status, reason)
  Object.assign(turn, turnStats(task, turn, now), { status, endedAt: new Date(now).toISOString() }, end ? { end } : {})
}

/**
 * 一轮的结局：按状态和停止原因归类。旧记录没有 end 字段，返回 undefined（报告里算「原因没记录」），
 * 不能默认成失败——那时多半只是保活结束或用户切走了页面
 */
export function turnEndOf(status: TaskTurn['status'], reason?: StopReason): TurnEnd | undefined {
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  if (reason === 'supersede') return 'supersede'
  if (reason === 'user') return 'user'
  // 其余都是面板（或别的动作）顺带结束的：父对话收尾、页面切走、闲置回收、归档、重启、换 CLI、CLI 没响应
  if (reason) return 'panel'
  return undefined
}

type Timed = { waitMs: number; waitStartedAt: string }
type Waiting = Timed & { requests: { step: string; at: string }[]; steps: (Timed & { id: string })[] }

function closeWait(o: Timed, now: number) {
  if (!o.waitStartedAt) return
  o.waitMs = (o.waitMs ?? 0) + Math.max(0, now - Date.parse(o.waitStartedAt))
  o.waitStartedAt = ''
}

/**
 * 记等用户的时间：有请求挂着（权限确认、提问、节点完成后的确认）就开始计，全部处理完时累加。
 * 任务和请求所在的节点各记一份。每次任务有变化时调用，开始时间取请求发出的时间，不受调用时机影响
 */
export function trackWait(task: Waiting, now = Date.now()) {
  const tick = (o: Timed, reqs: { at: string }[]) => {
    if (!reqs.length) return closeWait(o, now)
    if (o.waitStartedAt) return
    const at = Math.min(now, ...reqs.map((r) => Date.parse(r.at)).filter(Number.isFinite))
    o.waitStartedAt = new Date(at).toISOString()
  }
  const reqs = task.requests ?? []
  tick(task, reqs)
  for (const s of task.steps)
    if (s.waitStartedAt || reqs.some((r) => r.step === s.id))
      tick(
        s,
        reqs.filter((r) => r.step === s.id),
      )
}

/** 等用户的总时间（毫秒），含正在等的这一段 */
export function waitDuration(o: Partial<Timed>, now = Date.now()) {
  return (o.waitMs ?? 0) + (o.waitStartedAt ? Math.max(0, now - Date.parse(o.waitStartedAt)) : 0)
}

/** 节点执行了多久（毫秒）：之前被打断时做的部分加上这一次的；没开始过为 0 */
export function stepMs(
  step: { startedAt: string; endedAt: string; status: string; spentMs?: number },
  now = Date.now(),
) {
  const end = step.endedAt ? Date.parse(step.endedAt) : step.status === 'running' ? now : 0
  const cur = step.startedAt && end ? Math.max(0, end - Date.parse(step.startedAt)) : 0
  return (step.spentMs ?? 0) + cur
}

/** 节点被停止或打断：已经做的时间记进 spentMs，续接时接着算 */
export function pauseStep(step: { startedAt: string; spentMs: number }, now = Date.now()) {
  if (step.startedAt) step.spentMs = (step.spentMs ?? 0) + Math.max(0, now - Date.parse(step.startedAt))
  step.startedAt = ''
}

/**
 * 任务执行了多久（毫秒）：已完成的几段加上正在执行的这一段；停在等用户时 runStartedAt 已经清空，
 * 这段空闲不算执行（见 pauseRun）。旧任务没有记录时按创建到最后更新估算
 */
export function taskDuration(
  task: { status: string; runMs?: number; runStartedAt?: string; createdAt: string; updatedAt: string },
  now = Date.now(),
) {
  const live = task.runStartedAt ? Math.max(0, now - Date.parse(task.runStartedAt)) : 0
  const ms = (task.runMs ?? 0) + live
  if (ms > 0 || task.status === 'running') return ms
  return Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.createdAt))
}

/** 对话里能不能临时选 CLI、模型和思考强度：不用角色（空 id）时可以 */
export const canPickRun = (agentId: string) => !agentId

/** 不用角色的对话任务选的 CLI、模型和思考强度 */
export function withTaskModel<A extends { id: string; cli: string; model: string; effort: string }>(
  agent: A,
  task: { mode: string; agentId: string; cli?: string; model?: string; effort?: string },
): A {
  if (task.mode !== 'chat' || task.agentId !== agent.id || !canPickRun(agent.id)) return agent
  // 换了 CLI 时不能沿用原来的模型（那是另一个 CLI 的）
  const cli = task.cli || agent.cli
  const same = cli === agent.cli
  return {
    ...agent,
    cli,
    model: task.model || (same ? agent.model : ''),
    effort: task.effort || (same ? agent.effort : ''),
  }
}

/**
 * 两个目录是不是同一个（Windows 路径大小写、分隔符、末尾斜杠不敏感）。
 * 用来判断「会话开在哪个目录」与这一轮的目录是否一致。
 */
export function sameDir(a: string, b: string) {
  const norm = (s: string) =>
    s
      .replace(/[\\/]+/g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}

/**
 * 会话是不是在别处开的：CLI 的会话按目录存，换了目录续接就找不到。
 * 先看这个会话自己记的目录（sessionDirs），旧任务只有对话共用的 sessionDir。
 */
export function sessionMoved(
  task: Pick<Task, 'sessionDirs' | 'sessionDir'>,
  sessionKey: string,
  cwd: string,
  /** 对话以外的节点没有 sessionDir 可用 */
  chat = false,
) {
  const at = task.sessionDirs?.[sessionKey] || (chat ? (task.sessionDir ?? '') : '')
  return !!at && !sameDir(at, cwd)
}

/**
 * 对话中途换了 CLI、模型（会话里能换模型的 CLI 除外）或（不支持中途换强度的 CLI 换了）思考强度：
 * 原来的会话接不上，要开新会话把之前的对话带过去。
 */
export function sessionChanged(
  task: Pick<Task, 'messages' | 'sessionCli'>,
  cli: string,
  model: string,
  effort = '',
  effortBound = false,
  modelSwitch = false,
) {
  if (task.sessionCli && task.sessionCli !== cli) return true
  const last = [...task.messages].reverse().find((m) => m.run?.cli === cli)
  if (!last?.run) return false
  return (!modelSwitch && last.run.model !== model) || (effortBound && (last.run.effort ?? '') !== effort)
}

/**
 * 用户最近一次发消息的时间，没有就用创建时间。
 * 列表按它排序、显示它：Agent 回复、执行状态变化不改变顺序，只有用户发了新消息才排到前面
 */
export function askedAt(t: Pick<Task, 'messages' | 'createdAt' | 'askedAt'>) {
  let at = t.askedAt ?? ''
  for (const m of t.messages) if (m.role === 'user' && m.at > at) at = m.at
  return at || t.createdAt
}

/** 按用户最近发消息的时间排，新的在前 */
export const byAskedAt = (a: Task, b: Task) => askedAt(b).localeCompare(askedAt(a))

/**
 * 对话（顶层对话和子对话一样）这会儿处在哪个状态。只有这 8 个，判定只在 convState 一处（见 ADR 0005）：
 * - running 执行中：CLI 正在处理这一轮
 * - waiting 等结果：这一轮说完了，在等会自己推回来的结果（后台命令、工作流运行、派出的子任务）
 * - needs 等你处理：有待回答的提问、待确认的请求
 * - failed 失败：这一轮执行出错
 * - stopped 已中断：用户暂停，或者被别的动作打断（面板重启、换 CLI、父对话结束……）；
 *   彻底完成后面板顺手结束等下一句的进程（stopReason 为 finish）不算中断
 * - unfinished 未完成：这一轮正常说完了，但计划没做完，或者独立分支里还有没合回的改动、也还没请父对话收尾
 * - wrapup 待收尾：子对话只剩合回，已经请父对话收尾（合并、改计划、删分支），在等父对话
 * - done 已完成：顶层对话是这一轮答完、没有挂着的事；子对话是彻底完成（合回、回收）
 *
 * 列表分组（TaskStage）、行首图标（TaskIcon）、给父对话的状态上报、父计划里等它的那一步都从这里派生，
 * 不要在别处再拼一套「是不是做完了」。
 */
export type ConvState = 'running' | 'waiting' | 'needs' | 'failed' | 'stopped' | 'unfinished' | 'wrapup' | 'done'

/** 判定状态要看的事实：任务上有的直接取，后台命令数、合没合回这些服务端才知道的由调用方补 */
export interface ConvFacts {
  status: Task['status']
  /** CLI 正在处理这一轮：进程活着但在等下一句 / 预热时算 false */
  working?: boolean
  /** 子对话被置为完成（彻底完成才会置） */
  resolved?: boolean
  /** 正在等用户确认的请求数 */
  requests?: number
  /** 还没回答的提问数 */
  asking?: number
  /** 还在跑、排队的后台命令数 */
  background?: number
  /** 工作流运行还没跑完（见 runRunning） */
  workflow?: boolean
  /** 派出去的子任务还在跑（见 helpersWorking） */
  helpers?: boolean
  /** 名下还在动的子对话数（它们的 convState 是执行中、等结果、等你处理，见 convActive） */
  children?: number
  /** 计划还没做完 */
  unfinished?: boolean
  /** 独立分支还没合回父对话的分支 */
  unmerged?: boolean
  /** 子对话已经请父对话收尾、还没出结果（见 Task.wrapRequest） */
  wrapup?: boolean
  /** 停下的原因：finish 是彻底完成后的收尾，不算中断 */
  stopReason?: StopReason
  /** 已经收起（归档 / 独立分支被用户删掉）：见 taskGone；能不能归成已完成还要看它是不是没在动（见 convState） */
  gone?: boolean
}

/** 回收站保留期：删除只做标记，这么多天后才由启动后的清理任务物理删除（见 server/tasks.ts 的 cleanupTrash） */
export const TRASH_RETENTION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
/** 剩几天被物理删除：向上取整，0 表示下次清理就删；删除时间读不懂时按已到期算 */
export function trashLeftDays(deletedAt: string, now = Date.now()): number {
  const at = Date.parse(deletedAt)
  if (!Number.isFinite(at)) return 0
  const left = at + TRASH_RETENTION_DAYS * DAY_MS - now
  return left > 0 ? Math.ceil(left / DAY_MS) : 0
}

/** 已经进回收站（删除只是标记，内容还在，见 Task.deletedAt）；过期前仍能恢复 */
export const taskDeleted = (t: { deletedAt?: string | null }) => !!t.deletedAt

/**
 * 这条对话是不是已经从用户眼前收起了：归档、独立分支被用户删掉（子对话列表里归「已删除」的那类，
 * 见 web/src/lib/worktrees.ts 的分组），或者进了回收站（见 Task.deletedAt）。
 * 收起的对话任务记录还在 store 里，status / working 也可能还写着 running（进程是异步收尾的），
 * 所以「算不算在跑」的第一处就把它排掉：运行区、子对话栏、侧栏「N 个执行中」、标题计数都读这一处，
 * 不要在 RunningNow 或各处再叠一层 if，那会让运行区的判空和分隔线对不上（见 Messages.tsx 的 RunningFooter）。
 * 合回分支（merged）不算收起：改动已经进主线，任务本身照常可见。
 * 它只是「已经收起」这个事实，能不能归成已完成还要看它是不是没在动（见 convState）
 */
export const taskGone = (t: {
  archived?: boolean
  deletedAt?: string | null
  worktree?: Pick<NonNullable<Task['worktree']>, 'state'> | null
}) => t.archived === true || t.worktree?.state === 'discarded' || taskDeleted(t)

/**
 * 对话的状态，优先级从上到下：
 * 要你处理的最先（不然会被「执行中」盖住，用户不知道在等他）→ 失败（没有还会推回来的结果时）→ 执行中 → 等结果 →
 * 已收起（没在动时）→ 中断 → 待收尾 → 未完成 → 已完成。
 * 「已置完成」不盖住还在跑、还在等的事实：万一标早了，界面仍然如实显示在跑。
 */
export function convState(x: ConvFacts): ConvState {
  // 还有会推回来的结果（子对话、子任务、后台命令、工作流）
  const pending = !!(x.background || x.workflow || x.helpers || x.children)
  // 已收起（归档 / 删了独立分支）且真的没在动：收敛成已完成，不再显示「等你处理 / 已暂停 / 待收尾 / 未完成」。
  // 但不能盖住还在跑：用户删了独立分支后接着在原目录做（isolated 的注释：discarded 回到共用目录，worktree 不会清），
  // 或者在等后台命令 / 子对话的结果——这些照旧如实显示，和「已置完成」是同一条规矩。
  // 这也是侧栏「N 个执行中」、标题 (n)、保活回收判定的入口（见 convActive）
  if (x.gone && !x.working && !pending) return 'done'
  if (x.requests || x.asking) return 'needs'
  // 这一轮失败了但还有结果会推回来时不算失败：结果回来会接着开一轮，
  // 显示成「失败」的话列表不转圈、回收也会把它当成停下了的（见 convActive）
  if (x.status === 'failed' && !pending) return 'failed'
  if (x.working) return 'running'
  if (pending) return 'waiting'
  if (x.status === 'stopped' && !x.resolved && x.stopReason !== 'finish') return 'stopped'
  if (x.wrapup && !x.resolved) return 'wrapup'
  if (x.unfinished || x.unmerged) return 'unfinished'
  return 'done'
}

/**
 * 这个对话还在运行：执行中、等结果（子对话、子任务、后台命令、工作流还没完）、等你处理（提问、请求没回复）。
 * 「在运行的对话不能杀」只认这一个判定：没人在看、不是当前选中的、保活超上限、父对话的 CLI 结束，
 * 都不能把还在运行的对话或它的子对话停掉（见 ADR 0012）。只有用户自己停止、归档、删除才停
 */
export const convActive = (s: ConvState) => s === 'running' || s === 'waiting' || s === 'needs'

/** 状态的说法：子对话栏、给父对话的上报、list_conversations 都用这一份 */
export function convStateText(s: ConvState | string): string {
  switch (s) {
    case 'running':
      return t('执行中')
    case 'waiting':
      return t('等结果')
    case 'needs':
      return t('等你处理')
    case 'failed':
      return t('失败')
    case 'stopped':
      return t('已中断')
    case 'unfinished':
      return t('未完成')
    case 'wrapup':
      return t('待收尾')
    case 'done':
      return t('已完成')
    default:
      return ''
  }
}

/** 子对话的事实：任务上有的直接取，后台命令、排队的下一轮、合没合回由服务端补 */
export function childFacts(
  task: Pick<Task, 'status' | 'working' | 'requests' | 'parentAsks' | 'plans' | 'steps' | 'resolved' | 'stopReason'> & {
    runs?: Task['runs']
    wrapRequest?: Task['wrapRequest']
    archived?: Task['archived']
    deletedAt?: Task['deletedAt']
    worktree?: Task['worktree']
  },
  x: { background?: number; unmerged?: boolean } = {},
): ConvFacts {
  return {
    status: task.status,
    working: task.working,
    resolved: task.resolved === true,
    requests: task.requests.length,
    asking: task.parentAsks?.length ?? 0,
    background: x.background,
    workflow: runRunning(task),
    helpers: helpersWorking(task),
    unfinished: !!openPlan(task),
    unmerged: x.unmerged,
    wrapup: !!task.wrapRequest && task.wrapRequest.state !== 'failed',
    stopReason: task.stopReason,
    gone: taskGone(task),
  }
}

/** 子对话交给父对话的状态上报：父计划里等它的那一步怎么收口、要不要发一条消息 */
export interface ChildReport {
  state: ConvState
  /** hold：那一步继续等（只改说明）；ok：标完成；fail：退回进行中 */
  settle: 'hold' | 'ok' | 'fail'
  /** 一句话：现在的状态和原因，写进父计划那一步的说明，也是上报消息的第一行 */
  why: string
  /** 要不要给父对话发一条状态消息：还在动的（执行中、等结果）只更新计划那一步的说明，不刷消息 */
  notify: boolean
}

/**
 * 子对话一轮结束（或者合并、置完成、收尾请求这些状态变化）时，交给父对话的是什么：
 * 状态只从 convState 来，父对话的计划、上报的说法、子对话栏用的是同一个结论。
 * 以前这里有一套单独的判据（childTurnSettle，只看 requests / working / status / 后台命令 / 计划），
 * 和列表的 childHolds 对不上：提问、工作流、派出的子任务都漏了，于是父对话收到「做完了」时子对话还在跑。
 * more：这一轮结束后还要接着处理排队的消息（面板交过来的、执行中收到的），也算还在执行
 */
export function childReport(
  task: Parameters<typeof childFacts>[0],
  x: { background?: string[]; more?: boolean; unmerged?: boolean } = {},
): ChildReport {
  const facts = childFacts(task, { background: x.background?.length, unmerged: x.unmerged })
  let state = convState(facts)
  if (x.more && state !== 'needs' && state !== 'failed') state = 'running'
  const plan = activePlan(task)
  const progress = plan ? planProgress(task, plan) : undefined
  const at = progress
    ? t('计划 {done}/{total}', { done: progress.done, total: progress.total }) +
      (progress.current ? ` · ${progress.current.child?.title || progress.current.step.title}` : '')
    : ''
  const work = openWork(task)
  const names = (list: string[]) =>
    list
      .slice(0, 3)
      .map((n) => t('「{name}」', { name: n }))
      .join(t('、')) + (list.length > 3 ? t(' 等 {n} 项', { n: list.length }) : '')
  const reason = (() => {
    switch (state) {
      case 'running':
        return x.more ? t('这一轮结束后还要接着处理排队的消息') : at
      case 'waiting':
        if (x.background?.length) return t('后台命令还在跑：{list}', { list: names(x.background) })
        return facts.workflow ? t('工作流还没跑完') : t('派出的子任务还没跑完')
      case 'needs':
        return t('有没答的提问，在等用户回答')
      case 'failed':
        return t('执行失败了')
      case 'stopped':
        return stopReasonText(task.stopReason)
      case 'unfinished':
        if (work.length)
          return t('计划还没做完：{list}', {
            list: names(work.map((s) => s.title)),
          })
        return t('只剩合回父对话的分支，还没请你收尾')
      case 'wrapup':
        // 合回已经做完、面板正在父对话目录里跑勾了「禁止子对话执行」的步骤（见 ADR 0018）：
        // 这时收尾还早，说法不能再是「用 finish_child 合并」
        return task.wrapRequest?.state === 'testing'
          ? t('已合回，等父对话跑测试（面板自动执行，结果回传给它）')
          : task.wrapRequest?.state === 'test-failed'
            ? t('已合回，父对话测试没通过，已经退回给它修（修好再请父对话收尾）')
            : t('只剩合回，已请你收尾：用 finish_child 合并、标完成、删独立分支')
      case 'done':
        return t('交付完了：计划、后台命令、提问都收口了')
    }
  })()
  return {
    state,
    settle: state === 'done' ? 'ok' : state === 'failed' || state === 'stopped' ? 'fail' : 'hold',
    why: [convStateText(state), reason].filter(Boolean).join(t('：')),
    notify: state !== 'running' && state !== 'waiting' && state !== 'needs',
  }
}

/**
 * 任务（含子对话）当下的阶段：列表分组用，是 ConvState 归并成的 5 组，
 * 避免列表说一个说法、点进去又是另一个。
 */
export type TaskStage = 'you' | 'running' | 'unfinished' | 'done' | 'stopped'

/** 状态归到列表的哪一组：等你处理和失败都要你看，执行中和等结果都还在动，待收尾和未完成都还差一步 */
export function stageOf(s: ConvState): TaskStage {
  if (s === 'needs' || s === 'failed') return 'you'
  if (s === 'running' || s === 'waiting') return 'running'
  if (s === 'wrapup' || s === 'unfinished') return 'unfinished'
  return s
}

/**
 * 子对话离「彻底完成」还差哪几样（见 childHolds），空数组才算做完了
 */
export type ChildHold =
  | 'working'
  | 'background'
  | 'workflow'
  | 'helpers'
  | 'plan'
  | 'asking'
  | 'requests'
  | 'unmerged'
  | 'parentTest'

/**
 * 子对话的收尾建议没给可选做法时用这两个：第一个是推荐做法，最后一个是明确停下。
 * 「换个做法」由选择弹窗自带的「自己输入」覆盖，不单独占一项
 */
export const suggestChoices = () => [t('按建议继续（推荐）'), t('先不做，先停在这')]

/**
 * 提问、收尾建议的可选做法：去掉空白和重复，最多 6 个。
 * 收尾建议一个都没给时用默认的两项——弹窗里没有选项只剩输入框，用户就得自己写，
 * 等于又变回「看着建议不知道下一步该干什么」
 */
export function askOptions(options: string[] | undefined, kind: AskKind = 'question'): string[] {
  const list = [...new Set((options ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))]
  if (list.length) return list.slice(0, 6)
  return kind === 'suggestion' ? suggestChoices() : []
}

/**
 * 子对话彻底完成要满足的条件，缺哪个列哪个：
 * - working：这一轮还在跑
 * - background：后台命令还在跑 / 排队（结果推回来还要接着做）
 * - workflow：start_plan 启动的工作流运行还没跑完（工具调用返回得比运行本身早，不能只看这一轮跑没跑）
 * - helpers：它派出去的子任务还在跑（结果交回来时它还要接着做）
 * - plan：计划还没做完（见 shared/plan.ts 的 openPlan）
 * - asking：还有待用户回答的提问
 * - requests：还有待用户确认的请求
 * - unmerged：独立分支还有没合回父对话分支的改动
 * - parentTest：合回了，父对话还在跑勾了「禁止子对话执行」的测试步骤（见 ADR 0018）
 *
 * 合并成功、一轮结束、标记完成、回收独立分支、面板阶段显示都读这一份：
 * 以前合并成功就当场标完成、删 worktree，计划、提问、后台命令全都没查，
 * 于是「已完成」和「还在跑」同时成立、目录还在被写就被删掉。
 */
export function childHolds(x: {
  working?: boolean
  /** 还在跑、排队的后台命令数 */
  background?: number
  /** 工作流运行还没跑完（见 runRunning） */
  workflow?: boolean
  /** 派出去的子任务还在跑（见 helpersWorking） */
  helpers?: boolean
  /** 还没做完的计划进度（openPlan） */
  plan?: { done: number; total: number }
  asking?: number
  requests?: number
  /** 独立分支还没合回父对话的分支；没有独立分支时传 false / 不传 */
  unmerged?: boolean
  /** 合回了，但父对话的测试还没跑完或没通过（已退回修复）：跑通才收尾（见 ADR 0018） */
  parentTest?: boolean
}): ChildHold[] {
  const holds: ChildHold[] = []
  if (x.working) holds.push('working')
  if (x.background) holds.push('background')
  if (x.workflow) holds.push('workflow')
  if (x.helpers) holds.push('helpers')
  if (x.plan && x.plan.done < x.plan.total) holds.push('plan')
  if (x.asking) holds.push('asking')
  if (x.requests) holds.push('requests')
  if (x.unmerged) holds.push('unmerged')
  if (x.parentTest) holds.push('parentTest')
  return holds
}

/** 子对话彻底完成了：可以标完成、回收独立分支 */
export const childComplete = (x: Parameters<typeof childHolds>[0]) => childHolds(x).length === 0

/**
 * 工作流运行还在跑：start_plan 启动的那次运行（task.runs 最后一条）还没结束。
 * 「启动工作流」这个工具调用一下子就会返回，运行本身在它后面接着跑，只看这一轮跑没跑会把还在跑的工作流当成结束。
 */
export function runRunning(task: { status: Task['status']; runs?: Task['runs']; steps?: Task['steps'] }): boolean {
  if (task.status !== 'running') return false
  const run = task.runs?.at(-1)
  // 有运行记录就以它为准：节点状态在运行结束时自己就收口了，不拿它重复判
  if (run) return run.status === 'running' && !run.endedAt
  // 旧任务没有运行记录：这一轮里还有节点在跑就算（派出的子任务是另一回事，见 helpersWorking）
  return !!task.steps?.some((s) => s.slot !== 'sub' && s.status === 'running')
}

/**
 * 子对话的任务状态换成 childHolds 的入参：服务端置完成、删独立分支、界面显示都从这里取，不要各写一套。
 * merged 传 false 表示独立分支还没合回去；不传或 true 表示已经合了（或者根本没有独立分支）。
 */
export function childHoldsOf(
  task: Pick<Task, 'status' | 'working' | 'requests' | 'parentAsks' | 'plans' | 'steps'> & { runs?: Task['runs'] },
  x: { background?: number; merged?: boolean; parentTest?: boolean } = {},
): ChildHold[] {
  return childHolds(childFlowOf(task, x))
}

/**
 * 子对话完成是一条单向的状态流转，必须按这个先后走，谁都不能跳步（见 advanceChild）：
 * wrapup 这一轮收尾 → plan 计划全做完 → pending 后台命令 / 工作流 / 派出的子任务 / 提问 / 请求都收口
 * → complete 子对话自己置完成 → report 上报父对话 → list 父对话列表按上报的状态刷新。
 *
 * 「父对话点标记完成」「合并成功」都只是发起这一趟流转（见 server/tasks.ts 的 advanceChildTo），
 * 判定和置完成仍然在子对话这一侧，父对话不直接改最终状态。
 */
export type ChildFlowStep = 'wrapup' | 'plan' | 'pending' | 'complete' | 'report' | 'list'

/** 流转的先后：只能从前往后走，中间不能跳过任何一步 */
export const childFlowSteps = [
  'wrapup',
  'plan',
  'pending',
  'complete',
  'report',
  'list',
] as const satisfies readonly ChildFlowStep[]

/** 流转要看的子对话现状：条件和 childHolds 一致，多两个「走到哪一步」的标记 */
export type ChildFlowState = Parameters<typeof childHolds>[0] & {
  /** 子对话这一侧已经把自己置为完成（resolved）：只有它能写这一步 */
  completed?: boolean
  /** 父对话已经收到「子对话已完成」的上报 */
  reported?: boolean
}

/**
 * 子对话的任务状态换成流转要看的现状：服务端判定、置完成和界面显示都从这里取，不要各写一套。
 * merged 传 false 表示独立分支还没合回去；reported 表示父对话已经收到过这次完成的上报。
 */
export function childFlowOf(
  task: Pick<Task, 'status' | 'working' | 'requests' | 'parentAsks' | 'plans' | 'steps'> & {
    runs?: Task['runs']
    resolved?: boolean
  },
  x: { background?: number; merged?: boolean; reported?: boolean; parentTest?: boolean } = {},
): ChildFlowState {
  return {
    working: task.working,
    background: x.background,
    workflow: runRunning(task),
    helpers: helpersWorking(task),
    plan: openPlan(task),
    asking: task.parentAsks?.length ?? 0,
    requests: task.requests.length,
    unmerged: x.merged === false,
    parentTest: x.parentTest,
    completed: task.resolved === true,
    reported: x.reported,
  }
}

/** 某一步自己还差什么（前一步过没过由 stepPassed 管）：空数组表示这一步的条件已经满足 */
export function childStepHolds(x: ChildFlowState, step: ChildFlowStep): ChildHold[] {
  if (step === 'wrapup') return childHolds({ working: x.working })
  if (step === 'plan') return childHolds({ plan: x.plan })
  if (step === 'pending')
    return childHolds({
      background: x.background,
      workflow: x.workflow,
      helpers: x.helpers,
      asking: x.asking,
      requests: x.requests,
      unmerged: x.unmerged,
      // 合回了但父对话的测试还没跑完：不能标完成、不能删分支（ADR 0018）。
      // 只加在 ChildFlowState 上而不传进来，这个 hold 永远不会生效（评审 R1）
      parentTest: x.parentTest,
    })
  // 后三步没有额外条件：走到没走到由 completed / reported 记着，不看别的
  return []
}

/** 这一步走完了没有：前一步没走完，这一步不管自己的条件满不满足都算没到 */
function stepPassed(x: ChildFlowState, step: ChildFlowStep): boolean {
  const i = childFlowSteps.indexOf(step)
  if (i > 0 && !stepPassed(x, childFlowSteps[i - 1])) return false
  if (step === 'complete') return !!x.completed
  if (step === 'report') return !!x.reported
  // 父对话的列表是按上报的状态派生出来的：上报了这一步就算过了，列表不会早于上报
  if (step === 'list') return !!x.reported
  return childStepHolds(x, step).length === 0
}

/** 现在卡在哪一步：返回前面几步都走完、自己还没走完的第一步；全部走完返回 null */
export function childFlowAt(x: ChildFlowState): ChildFlowStep | null {
  return childFlowSteps.find((s) => !stepPassed(x, s)) ?? null
}

/** 推进时某一步交回「还不该走」的原因（如独立分支回收失败）：交回后就停在这一步，不往下走 */
export interface ChildFlowStop {
  holds: ChildHold[]
  /** 给用户看的原因；不写就用 childHoldText(holds) */
  info?: string
}

/** 流转要做的三件事：子对话置完成、上报父对话、让父对话列表重取 */
export interface ChildFlowHost {
  /** 第 4 步：子对话这一侧把自己置为完成（回收独立分支也在这里）；交回还差什么就停在这一步 */
  complete(): void | ChildFlowStop | Promise<void | ChildFlowStop>
  /** 第 5 步：把「子对话已完成」上报给父对话 */
  report(): void | Promise<void>
  /** 第 6 步：需要额外通知页面重新取列表时提供；列表本身不在这里改写（只读子对话的状态） */
  list?(): void | Promise<void>
}

export interface ChildFlowRun {
  /** 这次真正做了的步骤，按先后顺序 */
  steps: ChildFlowStep[]
  /** 还没走完的步骤，第一项就是卡住的那一步；空数组表示整条链走完了 */
  left: ChildFlowStep[]
  /** 卡住的原因（见 childHoldText），空数组表示这一侧能做的都做了 */
  holds: ChildHold[]
  /** 卡住的说明，没卡住是空字符串 */
  info: string
}

/**
 * 按 wrapup → plan → pending → complete → report → list 依次推进，前一步没走完就停在原地。
 * 幂等：已经置过完成的不再置一次、已经上报过的不再报一次，重复调用只会从卡住的那一步接着走。
 * 父对话侧的动作（标记完成、合并成功、一轮结束收口）只调用它，不直接写子对话的最终状态。
 */
export async function advanceChild(x: ChildFlowState, host: ChildFlowHost): Promise<ChildFlowRun> {
  const state: ChildFlowState = { ...x }
  const steps: ChildFlowStep[] = []
  const stop = (at: number, holds: ChildHold[], info = ''): ChildFlowRun => ({
    steps,
    left: [...childFlowSteps.slice(at)],
    holds,
    info,
  })
  let i = childFlowSteps.findIndex((s) => !stepPassed(state, s))
  // 全部走完了：重复调用什么都不做
  if (i < 0) return { steps, left: [], holds: [], info: '' }
  for (; i < childFlowSteps.length; i++) {
    const step = childFlowSteps[i]
    // 前三步是「等条件」：不满足就停在原地，把还差什么交回去
    if (step === 'wrapup' || step === 'plan' || step === 'pending') {
      const holds = childStepHolds(state, step)
      if (holds.length) return stop(i, holds, childHoldText(holds))
      continue
    }
    if (step === 'complete') {
      const refused = await host.complete()
      if (refused && refused.holds.length) return stop(i, refused.holds, refused.info ?? childHoldText(refused.holds))
      state.completed = true
    } else if (step === 'report') {
      await host.report()
      state.reported = true
    } else await host.list?.()
    steps.push(step)
  }
  return { steps, left: [], holds: [], info: '' }
}

/** 还差什么才算做完：给用户看的一句话（分支状态行、标记完成的提示共用） */
export function childHoldText(holds: ChildHold[]) {
  const what: Record<ChildHold, string> = {
    working: t('这一轮还在执行'),
    background: t('后台命令还没跑完'),
    workflow: t('工作流还没跑完'),
    helpers: t('派出的子任务还没跑完'),
    plan: t('计划还没做完'),
    asking: t('还有等你回答的提问'),
    requests: t('还有等你确认的请求'),
    unmerged: t('独立分支还没合回原分支'),
    parentTest: t('父对话的测试还没通过'),
  }
  return holds.map((h) => what[h]).join(t('、'))
}

/**
 * 一个任务属于哪个阶段：就是 convState 归成的组（见 stageOf）。
 * 「已停止」只认真的中断：对话交付完一轮后 status 仍是 running，只是 working 变回 false、CLI 在等下一句，
 * 它已经做完了，不能算停止；彻底完成后面板结束进程（stopReason 为 finish）也不算。
 */
export function taskStage(x: ConvFacts): TaskStage {
  return stageOf(convState(x))
}

/**
 * 这个子对话和兄弟子对话是否共用一个工作目录（共用才需要提示「文件撞了」）：
 * Git 项目里的子对话走独立分支——wantsWorktree 表示这一轮后要开、worktree 有 state 表示已经在自己的分支里
 * （active 正在用；merged 是合并后回收，继续对话时面板会自动重建），各改各的，真撞了是合并时的事，不用提醒；
 * 只有都没有（P4、SVN、没有版本控制，或项目设成共用目录）才是共用，后写的会覆盖先写的。
 * 用户主动丢弃的（discarded）之后回到父对话的目录，也算共用。
 */
export function sharesWorkdir(tk: Pick<Task, 'wantsWorktree' | 'worktree'>) {
  if (tk.wantsWorktree) return false
  return !tk.worktree || tk.worktree.state === 'discarded'
}

/**
 * 子对话「本次开启」的时间：最近一轮开始执行的时间。
 * 做完或停下后又接到新任务会开新的一轮，它就往前走，列表里重新排到最前面；
 * 还没执行过任何一轮的按创建时间算。
 */
export function childStartedAt(t: Pick<Task, 'turns' | 'createdAt'>) {
  return t.turns.at(-1)?.startedAt || t.createdAt
}

/**
 * 一行任务现在的图标。分组（childStage）、行内徽标、侧栏计数、标题里的 (n) 都从这一份派生，
 * 只允许这一处判定「它在干什么」：以前分组读 childStage、图标读 status + working、计数又是第三套，
 * 于是出现「已完成分组里的项不显示对勾」「已解决的项画成暂停」「两行在转圈、计数写 1」。
 */
export type TaskIcon = 'running' | 'waiting' | 'done' | 'stopped' | 'idle' | 'failed'

/**
 * 子对话列表排序要用的字段：父对话的子对话栏、悬浮窗列表都传这些进来
 */
export interface ChildEntry {
  id: string
  title: string
  status: Task['status']
  working: boolean
  cliAlive: boolean
  /** 本次开启的时间，见 childStartedAt */
  startedAt: string
  /** 这一轮做完的时间、用户看过的最近一轮完成时间：两者不同就是「做完还没看」（见 taskTurnUnread） */
  turnDoneAt?: string
  turnSeenAt?: string
  /** 正在等用户确认的请求数、没回答的提问数：都算「需要你处理」 */
  requests?: number
  asking?: number
  /** 用户标记的「解决」：算已完成 */
  resolved?: boolean
  /** AI 分析开出的子对话（见 Task.analysis）：列表里标题和别的子对话区分开 */
  analysis?: Task['analysis']
  /** 还没做完的计划：「计划 7/8」，有它就不算已完成；正在做的那一步也带上 */
  plan?: { done: number; total: number; step?: string; child?: string }
  /** 已经收起（归档 / 独立分支被删掉）：见 taskGone；没在动时不算执行中、也不进运行区 */
  gone?: boolean
  background?: number
  /** 工作流运行还没跑完：转圈不能提前停（见 runRunning） */
  workflow?: boolean
  /** 派出去的子任务还在跑：转圈不能提前停（见 childHolds） */
  helpers?: boolean
  /** 独立分支还没合回父对话的分支：不算彻底完成，列表里归「未完成」（见 childHolds 的 unmerged） */
  unmerged?: boolean
  /** 独立分支目录里还有几个文件没提交（停下时提示用户改动还在，并且可以接着做） */
  dirty?: number
  /** 独立分支目录：和 dirty 一起说明改动在哪 */
  dir?: string
  /** 已经请父对话收尾、还没出结果：列表里是「待收尾」（见 ConvState） */
  wrapup?: boolean
  /** 停在 stopped 的原因：只有 'user' 是用户自己按的暂停，别的都是顺带结束（见 StopReason） */
  stopReason?: StopReason
  /** 最后有动静的时间（见 childLastActivity）：超时没新输出时标黄 / 标红 */
  lastActivityAt?: string
  /** 面板以父对话的名义自动问过它状态、在等回复（见 childIdleAsk / childAutoAskWaiting） */
  autoAsk?: { at: string; count: number; held?: boolean }
  /** 这会儿在等什么（见 childWait）：不是在跑也不是卡住 */
  waiting?: ChildWait
}

/** 子对话这会儿在做什么：父对话的子对话栏接在名字后面显示（前五项只有一项有值） */
export interface ChildActivity {
  /** 正在跑的工作流节点 */
  steps?: string[]
  /** 在等的子任务 */
  helpers?: string[]
  /** 正在调用（或刚调用完）的工具 */
  tool?: Pick<ToolUse, 'kind' | 'name' | 'label'>
  /** 正在说的最后一句 */
  text?: string
  /** 还没有输出，在想 */
  thinking?: boolean
  /** 正在做的计划步骤（和上面几项可以同时有值）：父对话不用翻计划窗口也知道做到第几步 */
  plan?: { title: string; child?: string; done: number; total: number }
}

/**
 * 子对话在等什么：不是在跑，但也不是卡住。父对话问「是不是卡住了」时靠它回答，
 * 列表里超时没新输出也先看这一项，能解释的等待不标红
 */
export type ChildWait =
  | { kind: 'answer'; n: number }
  | { kind: 'confirm'; n: number }
  | { kind: 'background'; n: number }
  | { kind: 'helpers'; list: string[] }
  | { kind: 'workflow' }
  | { kind: 'next' }

/** 等待原因的一句话：子对话栏、list_conversations、计划面板都用它 */
export function childWaitText(w: ChildWait | undefined): string {
  switch (w?.kind) {
    case 'answer':
      return t('等用户回答 {n} 个提问', { n: w.n })
    case 'confirm':
      return t('等用户确认 {n} 项', { n: w.n })
    case 'background':
      return t('等 {n} 个后台命令', { n: w.n })
    case 'helpers':
      return t('等子任务：{list}', { list: w.list.join(t('、')) })
    case 'workflow':
      return t('等工作流跑完')
    case 'next':
      return t('等下一句')
    default:
      return ''
  }
}

/**
 * 子对话在等什么，按「越需要用户处理越靠前」排：等用户回答、等确认、等后台命令、
 * 等派出的子任务、等工作流运行，最后是这一轮结束后等下一句（进程还活着，cliAlive）。
 * background 由服务端给（后台命令在服务端跑，任务里只有编号），cliAlive 同理
 */
export function childWait(
  tk: Pick<Task, 'status' | 'working' | 'requests' | 'parentAsks' | 'steps'> & { runs?: Task['runs'] },
  x: { background?: number; cliAlive?: boolean } = {},
): ChildWait | undefined {
  const asking = tk.parentAsks?.length ?? 0
  if (asking) return { kind: 'answer', n: asking }
  const requests = tk.requests?.length ?? 0
  if (requests) return { kind: 'confirm', n: requests }
  if (x.background) return { kind: 'background', n: x.background }
  const helpers = tk.steps.filter(helperRunning).map((s) => s.title)
  if (helpers.length) return { kind: 'helpers', list: helpers }
  if (runRunning(tk)) return { kind: 'workflow' }
  if (!tk.working && x.cliAlive) return { kind: 'next' }
  return undefined
}

/**
 * 子对话这会儿在做什么：在跑的工作流节点、在等的子任务、正在调用的工具，或者正在说的最后一句；
 * 计划没做完时附上正在做的那一步。没在执行时没有
 */
export function childActivity(tk: Pick<Task, 'working' | 'steps' | 'messages' | 'plans'>): ChildActivity | undefined {
  const plan = activePlan(tk)
  const p = plan ? planProgress(tk, plan) : undefined
  const doing = p?.current
    ? { title: p.current.step.title, child: p.current.child?.title, done: p.done, total: p.total }
    : undefined
  if (!tk.working) return doing ? { plan: doing } : undefined
  const running = tk.steps.filter((s) => s.status === 'running' && s.kind !== 'main')
  const nodes = running.filter((s) => !s.parentId).map((s) => s.title)
  if (nodes.length) return { steps: nodes, plan: doing }
  const helpers = running.filter(helperRunning).map((s) => s.title)
  const last = [...tk.messages].reverse().find((m) => m.role === 'agent' && !m.step)
  const tool =
    [...(last?.tools ?? [])].reverse().find((x) => x.running) ?? (last?.text.trim() ? undefined : last?.tools.at(-1))
  if (tool) return { tool: { kind: tool.kind, name: tool.name, label: tool.label.slice(0, 200) }, plan: doing }
  if (helpers.length) return { helpers, plan: doing }
  const line = (last?.text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  if (line) return { text: line.slice(0, 200), plan: doing }
  return { thinking: true, plan: doing }
}

/**
 * 在做什么的一句话：父对话的 list_conversations、计划面板的等待行用它；
 * 界面的子对话栏用自己的富文本（工具名按对话里的说法显示）
 */
export function childActivityText(a: ChildActivity | undefined): string {
  if (!a) return ''
  const doing = a.steps?.length
    ? a.steps.join(t('、'))
    : a.tool
      ? a.tool.label
      : a.helpers?.length
        ? t('等子任务：{list}', { list: a.helpers.join(t('、')) })
        : (a.text ?? (a.thinking ? t('正在思考…') : ''))
  const plan = a.plan
    ? t('计划 {done}/{total} · {step}', {
        done: a.plan.done,
        total: a.plan.total,
        step: a.plan.child || a.plan.title,
      })
    : ''
  return [doing, plan].filter(Boolean).join(' · ')
}

/**
 * 子对话最后有动静的时间：最后一条消息的时间、节点开始/结束时间，和任务更新时间里最晚的那个。
 * 一直在跑但几分钟没有任何新输出的，用这个标出来，父对话不用拿分支时间戳猜
 */
export function childLastActivity(t: Pick<Task, 'messages' | 'steps' | 'updatedAt'>): string {
  let at = t.updatedAt || ''
  const msg = t.messages.at(-1)?.at
  if (msg && msg > at) at = msg
  for (const s of t.steps) {
    if (s.startedAt && s.startedAt > at) at = s.startedAt
    if (s.endedAt && s.endedAt > at) at = s.endedAt
  }
  return at
}

/** 「3 分钟前」这类相对时间：子对话列表、计划面板、给父对话的对话清单都用它 */
export function timeAgo(iso: string, now = Date.now()) {
  if (!iso) return ''
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return ''
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) })
  if (s < 86400 * 30) return t('{n} 天前', { n: Math.floor(s / 86400) })
  return new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'zh-CN')
}

/** 多久没有任何新输出算慢（黄）、算可能卡住（红）：模型一步就要几十秒，阈值留足 */
export const CHILD_SLOW_MS = 120_000
export const CHILD_STALE_MS = 600_000

/**
 * 执行中但一段时间没有任何新输出：'' 正常、'slow' 慢、'stale' 可能卡住。
 * 等后台命令、等用户、等工作流这类能解释的等待不标（那时候没输出是正常的）
 */
export function childStale(
  x: { working?: boolean; wait?: ChildWait; lastActivityAt?: string },
  now = Date.now(),
): '' | 'slow' | 'stale' {
  if (!x.working) return ''
  if (x.wait && x.wait.kind !== 'next') return ''
  const at = x.lastActivityAt ? Date.parse(x.lastActivityAt) : NaN
  if (!Number.isFinite(at)) return ''
  const idle = now - at
  if (idle >= CHILD_STALE_MS) return 'stale'
  if (idle >= CHILD_SLOW_MS) return 'slow'
  return ''
}

/**
 * 子对话多久没有输出就自动问它状态：阈值、上限和判定都写在这里，定时器只拿结论执行。
 * 只问还在执行的子对话；等用户、等后台命令、等工作流、等子任务这类能解释的等待不问
 * （那时候没输出是正常的）。上一次询问本身会刷新子对话的最后活动时间，所以从询问时间往后算静默；
 * 子对话回了话（lastActivityAt 晚于上一次询问）时次数清零，重新从阈值开始。
 */
export const CHILD_IDLE_ASK_MAX = 3

export interface ChildIdleAskDecision {
  ask: boolean
  /** 不问的原因：off 关闭、not-running 没在执行、waiting 在等能解释的东西、too-soon 没到阈值、limit 问够了 */
  reason?: 'off' | 'not-running' | 'waiting' | 'too-soon' | 'limit'
  /** 已经静默了多久（毫秒） */
  idleMs: number
  /** 这一次问过之后是这一轮静默里的第几次；不问时是现在的次数 */
  count: number
}

export function childIdleAsk(
  x: {
    /** 设置里的分钟数，0 关闭 */
    minutes: number
    working?: boolean
    lastActivityAt?: string
    /** 能解释的等待（见 childWait）：等用户、等后台命令、等工作流、等子任务时不问 */
    wait?: ChildWait
    /** 上一次自动询问的记录 */
    autoAsk?: { at: string; count: number }
    /** 一分钟多少毫秒：测试里缩短时间用，默认 60 秒 */
    unitMs?: number
  },
  now = Date.now(),
): ChildIdleAskDecision {
  if (x.minutes <= 0) return { ask: false, reason: 'off', idleMs: 0, count: x.autoAsk?.count ?? 0 }
  if (!x.working) return { ask: false, reason: 'not-running', idleMs: 0, count: x.autoAsk?.count ?? 0 }
  if (x.wait && x.wait.kind !== 'next')
    return { ask: false, reason: 'waiting', idleMs: 0, count: x.autoAsk?.count ?? 0 }
  const last = x.lastActivityAt ? Date.parse(x.lastActivityAt) : NaN
  if (!Number.isFinite(last)) return { ask: false, reason: 'too-soon', idleMs: 0, count: x.autoAsk?.count ?? 0 }
  const asked = x.autoAsk ? Date.parse(x.autoAsk.at) : NaN
  // 询问自己的那条消息也在 messages 里：从它之后继续算静默，否则每次问完都会重新等满一轮
  const since = Number.isFinite(asked) ? Math.max(last, asked) : last
  const idleMs = Math.max(0, now - since)
  // 问过之后子对话有了新的输出：重新从 0 次算
  const count = Number.isFinite(asked) && last > asked ? 0 : (x.autoAsk?.count ?? 0)
  if (idleMs < x.minutes * (x.unitMs ?? 60_000)) return { ask: false, reason: 'too-soon', idleMs, count }
  if (count >= CHILD_IDLE_ASK_MAX) return { ask: false, reason: 'limit', idleMs, count }
  return { ask: true, idleMs, count: count + 1 }
}

/** 自动问过状态、之后还没有新的输出：子对话栏写「已自动询问，等回复」，父对话不用再问一遍 */
export function childAutoAskWaiting(x: {
  autoAsk?: { at: string; count: number; held?: boolean }
  lastActivityAt?: string
}) {
  // 没交出去的那次已经从队列里撤掉了，不在等回复
  if (!x.autoAsk?.at || x.autoAsk.held) return false
  const asked = Date.parse(x.autoAsk.at)
  if (!Number.isFinite(asked)) return false
  const last = x.lastActivityAt ? Date.parse(x.lastActivityAt) : NaN
  return !Number.isFinite(last) || last <= asked
}

/** 子对话列表里状态分类的先后：要你处理的在最上面，然后执行中、未完成、做完的、停下的 */
const stageRank: TaskStage[] = ['you', 'running', 'unfinished', 'done', 'stopped']

/** 子对话列表里一行的状态：计划没做完、独立分支没合回、已请收尾都按 convState 一处判（见 ConvState） */
export const childState = (x: ChildEntry) => convState({ ...x, unfinished: !!x.plan && x.plan.done < x.plan.total })

/** 这一条在列表里算哪个阶段：计划没做完、独立分支没合回的不算已完成（见 taskStage） */
export const childStage = (x: ChildEntry) => stageOf(childState(x))

/**
 * 行首要不要转圈：还没彻底完成（还在干活、计划没做完、独立分支没合回）时转，
 * 一眼看出它还在跑，不会把「未完成」当成做完了。
 * 等用户处理（提问、待确认）不转：那是在等你，转圈会把「等你选择」说成「还在跑」
 */
/** 停下原因的文案：只有用户按的暂停才说「已暂停」，别的一律说清是谁结束的 */
export function stopReasonText(reason: StopReason | undefined): string {
  switch (reason) {
    case 'parent':
      return t('父对话结束时一起结束')
    case 'switch':
      return t('换 Agent / 模型时中断')
    case 'archive':
      return t('归档时结束')
    case 'delete':
      return t('删除时结束')
    case 'restart':
      return t('面板重启时中断')
    case 'presence':
      return t('页面切走后结束')
    case 'idle':
      return t('闲置太久已回收')
    case 'supersede':
      return t('被新消息打断')
    case 'finish':
      return t('做完后收尾')
    case 'stalled':
      return t('Agent 没有响应，面板重启了它')
    default:
      return t('已暂停')
  }
}

/**
 * 用户消息的交付结果一句话：用户在对话里能看懂的实际情况，不直接摆出内部枚举值。
 * 「插进当前轮」和「排到下一轮」必须说清区别：看得出这条消息是现在就会被处理，还是等这一轮完。
 */
export function deliveryText(how: DeliveryHow | undefined): string {
  switch (how) {
    case 'wait':
      return t('已交给 Agent，这一轮接着处理')
    case 'steer':
      return t('已插进当前这一轮')
    case 'notes':
      return t('已交给正在执行的 Agent，它会在这一轮里读取')
    case 'next-node':
      return t('已交给工作流里下一个开始的节点')
    case 'held':
      return t('这一轮结束后自动处理')
    case 'lost':
      return t('没送出去：这一轮停下了，重新发一次')
    case 'next':
      return t('这一轮已结束，按新的一轮处理')
    case 'restart':
      return t('Agent 没有响应，已重启并按新的一轮处理')
    // 页面本地状态：面板还没接收、Agent 也还没认领（见 DeliveryHow 的 pending）
    case 'pending':
      return t('待认领')
    default:
      return ''
  }
}

/**
 * 服务端让不让「继续」这个对话（POST /tasks/:id/resume 的准入条件：停在失败或停止）。
 * 名字故意不叫 canResume：界面上「继续」按钮能不能按还要看输入框空不空、流程没走完等（见 TaskView 的 canResume），
 * 两者同名不同义容易接错
 */
export const resumable = (status: Task['status']) => status === 'stopped' || status === 'failed'

/**
 * 这一行现在该显示什么图标：分组、行内徽标、计数都读它，判定只在这一处。
 * 优先级（和 taskStage 的顺序一致）：
 * - 执行失败 → failed（配具体原因）
 * - 这一轮在跑 / 后台命令 / 工作流 / 派出的子任务还在跑、计划没做完、独立分支没合回 → running（转圈）
 * - 有提问 / 待确认 → waiting（等你处理）
 * - 用户自己按的暂停 → stopped（暂停图标）
 * - 别的动作顺带结束的（父对话收尾、换 CLI、面板重启、页面切走）→ idle（停下了，但别说成「你暂停了」）
 * - 其余 → done（完成态，含 resolved 和「彻底做完、CLI 关了」）
 */
export function childIcon(x: ChildEntry): TaskIcon {
  const st = childState(x)
  if (st === 'failed') return 'failed'
  if (st === 'needs') return 'waiting'
  // 等结果、未完成、待收尾也转圈：还没做完，不能画成静止的
  if (st === 'running' || st === 'waiting' || st === 'unfinished' || st === 'wrapup') return 'running'
  if (st === 'done') return 'done'
  // 停下：只有用户按的暂停才是暂停图标，别的来源要说清是谁结束的
  return x.stopReason && x.stopReason !== 'user' ? 'idle' : 'stopped'
}

/** 行首要不要转圈：就是图标是 running，见 childIcon */
export const childSpinning = (x: ChildEntry) => childIcon(x) === 'running'

/**
 * 任务 → 子对话行：判定字段全部来自 childFacts（图标、分组、计数、上报本来就是同一套事实），
 * 只有「进程活着」「本次开启时间」「计划进度」这三项要现取。
 * 不要在这里另列一份 status / working / requests 之类的字段：childFacts 加一项判定字段时这里要自动跟上，
 * 手拼的话新字段永远漏（重启迁移按它落静止，漏一项就会继续画成在跑）。
 */
function childEntryOf(
  task: Parameters<typeof childFacts>[0] & Pick<Task, 'id' | 'title' | 'createdAt' | 'worktree'>,
): ChildEntry {
  return {
    // childFacts 里带的 unfinished 会被 childState 按 plan 进度重算，两者是同一个 openPlan
    ...childFacts(task, { unmerged: task.worktree?.state === 'active' }),
    id: task.id,
    title: task.title,
    // childFacts 里这几项是可选的（服务端补的事实可能没填），ChildEntry 要求必填
    working: !!task.working,
    requests: task.requests.length,
    asking: task.parentAsks?.length ?? 0,
    // 重启迁移走这一处：进程已经回收，这一项只影响「已关闭」标签，不参与图标判定
    cliAlive: false,
    startedAt: task.createdAt,
    plan: openPlan(task),
  }
}

/**
 * 面板重启 / 崩溃后，这条落盘里的任务还会不会被画成在跑（childIcon 是 running）。
 * 重启后 CLI 进程已经回收，后台命令、工作流、派出的子任务的内存记录也一起没了，凡是「还有人在做」的显示都不成立；
 * 启动迁移按它把任务落成已停止（stopReason: restart），行首图标、列表分组、「N 个执行中」的计数和
 * 「CLI 进程已回收」那句提示才会一起变静止（用户报的现象：重启后子对话还挂在执行中一直转圈）。
 * 判定走 childState / childIcon，和图标、分组、计数是同一处，不另写一套「算不算在跑」。
 * 例外是「待收尾」：它等的是父对话合并，不靠 CLI 进程，重启后照样能收，不落静止。
 */
export function restartInterrupted(
  task: Parameters<typeof childFacts>[0] & Pick<Task, 'id' | 'title' | 'createdAt' | 'worktree'>,
): boolean {
  const entry = childEntryOf(task)
  return childSpinning(entry) && childState(entry) !== 'wrapup'
}

/**
 * 面板重启 / 强制更新把 CLI 停掉之后，这条任务还有「要它自己接着干」的活没干完。
 *
 * 和 restartInterrupted 分开：那个回答「界面还会不会画成在跑」（含独立分支还没合回，见 childIcon），
 * 这个回答「重启后该不该把它列进继续名单」（强制更新记录被打断的任务、新版本启动后问用户要不要继续）。
 * 记录只按「进程还在跑」（working）挑，会把停在等下一句、计划却只做了 12/17 的父对话漏掉：
 * 子对话进了恢复名单被继续，父对话却停在「已中断」等用户手动点（用户报的现象）。
 *
 * 不算的四种：
 * - 用户手动暂停（`stopReason: 'user'`）：那是明确的「先别动」，不是一个被强制的更新打断，重启后不能默认接着跑；
 * - 待收尾（wrapRequest 已请求）：它等的是父对话合并（面板做的），不靠 CLI 进程；
 * - 独立分支还没合回：同上，重启后照样能收；
 * - 后台命令：jobs 不存盘（见 schema 的 Task.jobs），重启后无从判断，名单里也就算不到它。
 *
 * 工作流任务流程没走完、`status` 已是 `done` 的也不算：它自己那页有「继续流程」入口（`flowLeft`），
 * 不靠这条恢复名单。
 */
export function restartUnfinished(
  task: Pick<Task, 'status' | 'steps' | 'plans' | 'wrapRequest' | 'stopReason' | 'resolved' | 'awaitingUser'> & {
    runs?: Task['runs']
  },
): boolean {
  // 已经收口（resolved）的绝不回名单：它做完了、分支也合了，重启后再拉起就是白跑一轮（也会留下没人要的进程）
  if (task.resolved === true) return false
  // 用户按的暂停不回名单：弹窗默认全勾选，列出来等于推翻用户上一步的决定
  if (task.stopReason === 'user') return false
  // 已经请求父对话收尾、在等面板 / 父对话动作：剩下的事是合并或跑测试，重启后进程没了也不影响。
  // failed（没合进去）和 test-failed（合回了、父对话测试没过）都要它自己动手修，照常进恢复名单
  const wrap = task.wrapRequest?.state
  if (wrap === 'requested' || wrap === 'merging' || wrap === 'testing') return false
  // 这一轮被打断（还等派的子任务、工作流运行的也算在这里）：CLI 没了，结果不会自己回来。
  // 「停在等下一句」（awaitingUser）不算被打断：它这一轮已经说完，只剩用户下一句，
  // 还有没有活要自己干看计划（见下面一行）
  if (task.status === 'running' && !task.awaitingUser) return true
  // 这一轮说完了，但计划还没做完：重启后没人接着做，它不会自己往前走
  return !!openPlan(task)
}

/**
 * 强制更新停 CLI 之前要记下哪些任务（见 server/tasks.ts 的 interruptedTasks）：
 * - 现在真在跑的（working）；
 * - 名下还有在跑的子对话的父对话：子对话的结果要交回它，它不在名单里就没人接；
 * - 被打断后还有活要自己干的（restartUnfinished：这一轮被打断、计划没做完）。
 * 只按 working 挑会把停在等下一句、计划 12/17 的父对话漏掉：子对话进了恢复名单被继续，
 * 父对话却停在「已中断」等用户手动点（用户报的现象）。
 */
export function interruptedTaskIds(
  tasks: (Pick<
    Task,
    | 'id'
    | 'status'
    | 'steps'
    | 'plans'
    | 'wrapRequest'
    | 'stopReason'
    | 'resolved'
    | 'awaitingUser'
    | 'imported'
    | 'archived'
  > & {
    runs?: Task['runs']
  })[],
  working: { id: string; parentTaskId: string }[] = [],
): string[] {
  const ids = new Set<string>()
  for (const w of working) {
    ids.add(w.id)
    if (w.parentTaskId) ids.add(w.parentTaskId)
  }
  for (const tk of tasks) if (!tk.imported && !tk.archived && restartUnfinished(tk)) ids.add(tk.id)
  return [...ids]
}

/**
 * 这条任务已经收口、名下不该再有 CLI 进程：
 * - 完成（resolved）：子对话收尾、用户点「解决」之后就是它；
 * - 已经停下（stopped）：用户暂停、归档、重启迁移之后；
 * - 待收尾（已请父对话收尾 / 正在合并 / 父对话在跑测试）：这一轮已经结束，剩下的是父对话的动作；
 * - 这一轮做完且没有挂起事项（convState 是 done）：和界面「已完成」是同一个判定。
 *
 * 「停在等下一句」（status 仍是 running、awaitingUser）不算：进程留着就是为了接用户下一句，那是正常保活。
 * 兜底回收遗留进程（server/exec/orphans.ts 的 reapSettledTaskClis）只认这一处，不要在别处再拼一遍 status 组合。
 */
export function taskSettled(
  tk: Pick<
    Task,
    | 'status'
    | 'working'
    | 'requests'
    | 'parentAsks'
    | 'plans'
    | 'steps'
    | 'resolved'
    | 'stopReason'
    | 'wrapRequest'
    | 'archived'
    | 'deletedAt'
    | 'worktree'
  > & { runs?: Task['runs'] },
): boolean {
  if (tk.resolved === true) return true
  if (tk.status === 'running') return false
  if (tk.status === 'stopped') return true
  // failed / test-failed 不算：那两种要它自己动手修，重启后还会拉起 CLI（见 restartUnfinished）
  const wrap = tk.wrapRequest?.state
  if (wrap === 'requested' || wrap === 'merging' || wrap === 'testing') return true
  return convState(childFacts(tk, { unmerged: tk.worktree?.state === 'active' })) === 'done'
}

/** 行首换成「等你选择」的图标：有提问 / 待确认，真在等你拍板（失败还是用失败的图标） */
export const childWaiting = (x: ChildEntry) => childIcon(x) === 'waiting'

/**
 * 子对话这会儿真的在干活：这一轮在跑、后台命令还在跑，或者工作流运行没完（进程活着等下一句不算）。
 * 界面上的转圈、行内「执行中」、「运行中」汇总都用它，别只看 working：
 * 后台命令、工作流运行都不占这一轮，CLI 在那里等结果，那时子对话其实还没做完。
 */
export const childRunning = (x: Pick<ChildEntry, 'working' | 'background' | 'workflow' | 'helpers'>) =>
  !!x.working || !!x.background || !!x.workflow || !!x.helpers

/**
 * 浮层「运行中」只列真正在干活（working 或后台命令还在跑）的子对话：进程活着但在等下一句的，
 * 在它自己页面上是「等待你的下一条消息」，混进来就会被当成还在跑；
 * 反过来，已标记解决但还在跑的也要列出来——「已完成」不能盖住还在跑。
 * 已收起（归档 / 独立分支被删掉）的一律不列：它的任务记录还在 store 里、working 也可能还写着在跑，
 * 但用户已经把它删了（见 taskGone）
 */
export function runningChildren<T extends ChildEntry>(list: T[]): T[] {
  return list.filter((x) => !x.gone && childRunning(x))
}

/**
 * 子对话栏上的计数：分子是「还在进行」的数量，分母是进程还活着的子对话数。
 * 分子取转圈的那一批（childSpinning：这一轮在跑、后台命令、工作流、派出的子任务、计划没做完、
 * 独立分支没合回），和行首图标、行内徽标、悬浮层默认列表是同一套判定。
 * 以前分子只用 working 算（三个在转圈、上面却写 1/5），分组又是第三套，于是对不上。
 * 分母取进程还活着的不包含已关闭的：它们是还能切过去继续说的；
 * 分母比分子少时兜底不小于分子（进程刚在启动、进程信息还没回来时就是这种情况）。
 */
export function childCounts<T extends ChildEntry>(list: T[]) {
  // 分子就是转圈的那一批：不再自己 filter 一遍 childSpinning，免得两处哪天判断条件写岔
  const running = spinningChildren(list).length
  // 分母也排掉已收起的：进程可能还在收尾（cliAlive 暂为 true），但已经不在列表里了，
  // 否则会出现「运行区空、上面却写 0/1 个进行中」
  const alive = list.filter((x) => x.cliAlive && !x.gone).length
  return { running, total: Math.max(alive, running) }
}

/** 转圈的那一批：状态栏计数、悬浮层默认列表、输入框上方的卡片都用它，不要各处再 filter 一遍 */
export function spinningChildren<T extends ChildEntry>(list: T[]): T[] {
  return list.filter(childSpinning)
}

/** 按开始时间倒序：越晚开始的越靠上。旧记录没有开始时间时算最早，交给调用方用 id 兜底 */
function byStartedDesc(a: { startedAt?: string }, b: { startedAt?: string }) {
  return (b.startedAt || '').localeCompare(a.startedAt || '')
}

/**
 * 列表里「新的在前」：按开始时间倒序，越晚开始的越靠上；时间一样、或者旧记录 / 演示数据没有开始时间时，
 * 用 id 的序号兜底（`@chat/sub/h10` 比 `h2` 新），保证每次渲染顺序一致不抖动。
 * 兜底依赖编号随派出递增（engine 的 spawn 用「现存子任务数 + 1」，见 shared/engine.ts 的 n = have + i + 1），
 * 而删除都是整批的（dropRerun 删父亲下全部 sub、dropNodeSteps 删整棵子树），不会出现「删了 h1、留着 h3」
 * 再派回一个重复编号，所以这个方向成立。
 * 子任务列表（sortHelpers）和运行区的子任务行用它；子对话栏（sortChildren）的时间倒序也走 byStartedDesc，
 * 只是它同一时间按 id 升序兜底（改它会动到子对话列表的既有顺序），别再各处写一遍时间倒序。
 */
export function newestFirst(a: { id: string; startedAt?: string }, b: { id: string; startedAt?: string }) {
  return byStartedDesc(a, b) || b.id.localeCompare(a.id, undefined, { numeric: true })
}

/**
 * 子对话列表的顺序：先按状态分类（需要你处理 → 执行中 → 未完成 → 已完成 → 已停止），
 * 同一类里按本次开启的时间倒序（见 childStartedAt 和 byStartedDesc），时间一样按 id 升序兜底免得每次渲染抖动。
 * 排序键不取最近一条消息：执行中的输出会让列表不停跳。
 * 父对话里显示子对话、悬浮窗列表都用它；「全部」里的分组标题见 ChildSwitcher 的 childGroups，
 * 它按 list 的先后往各组里放，所以两边顺序一致。
 */
export function sortChildren<T extends ChildEntry>(list: T[]): T[] {
  return list.slice().sort((a, b) => {
    const byStage = stageRank.indexOf(childStage(a)) - stageRank.indexOf(childStage(b))
    if (byStage) return byStage
    return byStartedDesc(a, b) || a.id.localeCompare(b.id)
  })
}

/**
 * 对话页运行区要列的子对话：就是悬浮层「运行中」的那一批（spinningChildren），
 * 顺序也用它那一套（sortChildren：正在跑的在先，同类按派出时间）。
 * 弹窗、状态栏计数、消息流运行区全读这一个函数，别各处再 filter 一遍：
 * 以前运行区写的是 `working && !resolved`，于是「在等后台命令」「已解决但还在跑」「计划没做完」
 * 这几类弹窗里有、运行区没有，同一个页面上两处条目数对不上。
 */
export function visibleChildren<T extends ChildEntry>(list: T[]): T[] {
  return sortChildren(spinningChildren(list))
}

/** 运行区里一条子任务和它起的后台命令：一个子任务只占一行，不管起了几条命令 */
export interface SubStepJob<S, J> {
  step: S
  jobs: J[]
}

/**
 * 运行区的后台命令按来源分成两批：sub 是子任务（slot='sub' 的步骤）起的，按子任务归成一行；
 * own 是父对话自己起的（包括它挂在自己计划步骤上的）。
 * 判定只写这一处：job.step 指向的步骤是子任务才算。以前一条命令一行，一个子任务起了三条命令就列成三个
 * 同名的「子任务」（用户 2026-10-24 反馈）。老记录没有 job.step，自然落到 own（兼容旧数据）。
 */
export function splitStepJobs<S extends { id: string; slot?: string }, J extends { step?: string }>(
  steps: S[],
  jobs: J[],
): { sub: SubStepJob<S, J>[]; own: J[] } {
  const subs = new Map(steps.filter((s) => s.slot === 'sub').map((s) => [s.id, s]))
  const rows = new Map<string, SubStepJob<S, J>>()
  const own: J[] = []
  for (const j of jobs) {
    const step = j.step ? subs.get(j.step) : undefined
    if (!step) {
      own.push(j)
      continue
    }
    const row = rows.get(step.id) ?? rows.set(step.id, { step, jobs: [] }).get(step.id)!
    row.jobs.push(j)
  }
  return { sub: [...rows.values()], own }
}

/**
 * 任务列表按自然日分组：同一天的归到一组，组内保持传进来的顺序（列表本来就按时间倒序）。
 * 今天、昨天用相对说法，更早的写日期；不是今年的带上年份。
 * now 只有测试会传，正常用当前时间。
 */
export function groupByDay<T>(list: T[], at: (x: T) => string, now = new Date()) {
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = dayStart(now)
  const yesterday = dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const loc = getLang() === 'en' ? 'en-US' : 'zh-CN'
  const groups = new Map<string, { key: string; label: string; items: T[] }>()
  for (const x of list) {
    const d = new Date(at(x))
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    let g = groups.get(key)
    if (!g) {
      const day = dayStart(d)
      g = {
        key,
        label: day === today ? t('今天') : day === yesterday ? t('昨天') : dayLabel(d, now, loc),
        items: [],
      }
      groups.set(key, g)
    }
    g.items.push(x)
  }
  return [...groups.values()]
}

/** 更早那天的写法：今年的不写年份，别的年份写上 */
function dayLabel(d: Date, now: Date, loc: string) {
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(loc, { ...(sameYear ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric' })
}

/**
 * 列表用的任务摘要：侧栏、项目首页只要标题、状态、进度和用量。去掉消息内容、节点输出这些大块数据，
 * 只留第一条要求（截短）给搜索用。打开任务时再取完整内容。
 */
/**
 * 子任务这会儿在跑：输入框上方的计数、弹层「执行中」分组、子对话的「等子任务」都读它。
 * 以前这几处各写一份 `slot === 'sub' && status === 'running'`，口径一变就会有的是 2、有的是 3。
 */
export function helperRunning(s: Pick<TaskStep, 'status' | 'slot'>) {
  return s.slot === 'sub' && s.status === 'running'
}

/**
 * 子任务在列表里的档位：正在跑的、排队的、没做完的、做完的、终止的。
 * 组与组的顺序由它决定（分组见 HelperCards 的 helperGroups），组内再按 newestFirst 让最新的排在前面。
 */
export function helperRank(s: Pick<TaskStep, 'status' | 'slot'>) {
  return helperRunning(s) ? 0 : s.status === 'pending' ? 1 : s.status === 'failed' ? 2 : s.status === 'done' ? 3 : 4
}

/**
 * 子任务列表的顺序：先按档位分（执行中 → 排队中 → 未完成 → 已完成 → 已终止），
 * 同一档里最新的在最上面（见 newestFirst）：用户最后派出的那个就在最上面，不用往下翻。
 * 输入框上方的「子任务」列表和消息流里运行区的子任务行都读这一个函数，别各处再写一份排序。
 */
export function sortHelpers<T extends Pick<TaskStep, 'id' | 'status' | 'slot' | 'startedAt'>>(list: T[]): T[] {
  return list.slice().sort((a, b) => helperRank(a) - helperRank(b) || newestFirst(a, b))
}

/**
 * 子任务还没结束（在跑或在排队）：对话页运行区按这个列子任务行、终止按钮也只在这时出现。
 * 和子对话的 convActive 一个意思——没做完就算在运行，不因为没选中、在后台就不列
 */
export function helperActive(s: Pick<TaskStep, 'status' | 'slot'>) {
  return s.slot === 'sub' && (s.status === 'running' || s.status === 'pending')
}

/**
 * 对话派出的子任务（spawn_agents 的步骤）还在跑：CLI 这一轮已经回复完（working 已是 false），
 * 但对话停在那里等它们交回结果，在侧栏和项目首页里也算「还在跑」
 */
export function helpersWorking(t: Pick<Task, 'status' | 'steps'>) {
  return t.status === 'running' && t.steps.some(helperRunning)
}

/** 判定任务对外状态要读的字段：列表摘要和完整任务都有（childrenWorking、jobs 由服务端补） */
export type TaskFactsInput = Pick<Task, 'status' | 'steps' | 'working'> &
  Partial<Pick<Task, 'childrenWorking' | 'requests' | 'parentAsks' | 'resolved' | 'stopReason' | 'plans'>> & {
    runs?: Task['runs']
    jobs?: Task['jobs']
    archived?: Task['archived']
    worktree?: Task['worktree']
  }

/**
 * 顶层对话（也适用于子对话自己的页面）的事实：和 childFacts 是同一套，只是后台命令、子对话数取服务端补好的字段。
 * 侧栏、项目首页、标题栏、标签页计数都从这里经 convState 得出状态，别再各拼一套「在不在跑」
 */
export function taskFacts(x: TaskFactsInput): ConvFacts {
  return {
    status: x.status,
    working: x.working,
    resolved: x.resolved === true,
    requests: x.requests?.length ?? 0,
    asking: x.parentAsks?.length ?? 0,
    background: x.jobs?.length ?? 0,
    workflow: runRunning(x),
    helpers: helpersWorking(x),
    children: x.childrenWorking ?? 0,
    stopReason: x.stopReason,
    gone: taskGone(x),
  }
}

/** 任务对外的状态：见 convState */
export const taskState = (x: TaskFactsInput) => convState(taskFacts(x))

/**
 * 这一轮做完了、用户还没打开看过：侧栏橙点、项目首页「需要你处理」都读它。
 * 交出去的后台命令还没跑完时不算：这一轮说完了但对话还在等结果。
 * 只是「未读」这个历史事实，能不能画橙点还要看下面的 taskDoneDot。
 */
export const taskTurnUnread = (x: {
  turnDoneAt?: string
  turnSeenAt?: string
  jobs?: Task['jobs']
  /** 后台命令数：/children 的摘要里只有数量（不读整份任务），有它一样算「还在等结果」 */
  background?: number
}) => !!x.turnDoneAt && x.turnDoneAt !== x.turnSeenAt && !x.jobs?.length && !x.background

/**
 * 行首要不要画橙点（「这一轮做完、你还没看」）：只有对话确实停在完成态才画。
 * 未读是上一轮完成时留下的历史事实，对话后来又跑起来（转圈、等你处理、失败、被停）时它还在，
 * 两个一起画就成了「既完成未看、又还在跑」。当前打开的那个对话也不画。
 */
export function taskDoneDot(x: TaskFactsInput, unread: boolean, viewing = false) {
  if (!unread || viewing) return false
  return taskState(x) === 'done'
}

/**
 * 子对话行要不要画未读点（「这一轮做完、你还没看」）：和侧栏橙点同一份口径（taskTurnUnread），
 * 再加两条——只有真的做完才画，当前打开的那一个不画。
 * 还在跑 / 等你处理 / 停下 / 失败都不画：它们各有自己的图标和标签，再叠一个未读点会读成「做完了没看」，
 * 而且「没做完」不是「没读过」，是「还没有结果」。
 */
export function childDoneDot(x: ChildEntry, viewing = false) {
  if (viewing) return false
  if (!taskTurnUnread(x)) return false
  return childIcon(x) === 'done'
}

/**
 * 本地记下了「点开过的那一轮」，这条要不要按已读算：服务端还没记成看过（仍是 taskTurnUnread），
 * 而且记下的就是当前这一轮（它又跑了一轮时不能算看过）。
 * 给父对话页用：点开子对话时先本地清掉未读点，4 秒一次的 /children 轮询抢在子对话自己的 /seen 前面时，
 * 不把点又画回来（见 web/src/components/tasks/TaskView.tsx 的 withLocalSeen）。
 * 判定和 taskDoneDot / childDoneDot 同一处：组件里不自己比两个时间戳。
 */
export function childSeenLocally(x: ChildEntry, seenAt: string | undefined) {
  if (!seenAt || seenAt !== x.turnDoneAt) return false
  return taskTurnUnread(x)
}

/** 任务还在运行（不能被回收、失活）：见 convActive */
export const taskActive = (x: TaskFactsInput) => convActive(taskState(x))

/**
 * 列表里的「执行中」（转圈）：自己在执行，或者在等结果——名下子对话、派出的子任务、后台命令、工作流还没完。
 * 等你处理（提问、请求）不转圈，画成提问图标，但同样算还在运行（taskActive）
 */
export function taskBusy(x: TaskFactsInput) {
  const s = taskState(x)
  return s === 'running' || s === 'waiting'
}

/** 「等结果」时在等什么：项目首页、标题栏悬停写这一句，和 convState 用同一份事实 */
export function taskWaitText(x: TaskFactsInput): string {
  const f = taskFacts(x)
  if (f.children) return t('子对话执行中')
  if (f.helpers) return t('子任务执行中')
  if (f.background) return t('后台命令执行中')
  if (f.workflow) return t('工作流执行中')
  return ''
}

/**
 * 列表里「执行中」的条数：侧栏项目名的「N 个执行中」、标签页标题的 (n) 都读这个，
 * 行首图标也是同一个判定（taskBusy）——以前标题只看 working，两行在转圈却写「1 个执行中」。
 */
export function taskBusyCount(list: Parameters<typeof taskBusy>[0][]): number {
  return list.filter((t) => taskBusy(t)).length
}

/**
 * 保活回收判定：这个对话还在运行吗？在运行的不按两段时间回收、也不参与上限淘汰（ADR 0012）。
 * 状态部分就是 convActive（taskFacts）：在跑、在等子任务 / 子对话 / 后台命令 / 工作流、有没回复的提问和请求；
 * 另外这一轮没收尾、在预热也算。后台命令数和名下还在运行的子对话数不在任务数据里，由调用方按运行时情况传。
 */
export function keepAliveBusy(
  t: TaskFactsInput & Partial<Pick<Task, 'awaitingUser' | 'prewarming'>>,
  x: { background?: number; children?: number } = {},
) {
  // CLI 正在回话 / 还在启动
  if (t.working || t.prewarming) return true
  // 这一轮没收尾：包括在等它派出的子任务（那时 awaitingUser 仍是 false）
  if (t.status === 'running' && !t.awaitingUser) return true
  return convActive(convState({ ...taskFacts(t), background: x.background ?? 0, children: x.children ?? 0 }))
}

/**
 * 保活回收的完整结论（见 server/tasks.ts 的 keepAliveBusy）：先分清这一轮还在不在执行位里。
 * - 在（这一轮在跑、或者停在等下一句保活着）：看任务自己的事实，见上面的 keepAliveBusy；
 * - 不在（这一轮结束、进程已退出，例如不支持保活的 CLI）：名下还有子对话 / 后台命令没回来时它在等结果，
 *   不能按「没人看就不留着」回收——回收会把它落成「已中断」，子对话的结果回来时没人在等（用户报的「父对话被回收」）。
 * 回收时长、保活上限都只问这一处，不在各触发点各写一个 if（ADR 0012）
 */
export function keepAliveHolding(x: {
  /** 还在执行位里（Live 里有一条） */
  live: boolean
  /** 自己任务上的事实：只在执行位里时用得上 */
  task?: Parameters<typeof keepAliveBusy>[0]
  /** 这一轮之后还要接着做（排队的消息、正在启动） */
  more?: boolean
  background?: number
  children?: number
}) {
  // 没有执行位就拿不到任务数据（这个判定在 presence 的计时器里同步调，读不了 store），只看名下还在跑的：
  // 它们在等结果，不能回收
  if (!x.live) return !!x.more || !!(x.children || x.background)
  if (x.more) return true
  return !!x.task && keepAliveBusy(x.task, { background: x.background, children: x.children })
}

/**
 * 保活会话（回复完停在等下一句、CLI 进程还没退）超过全局上限时要结束哪几个：
 * 只从没人在看的里面挑最近使用时间最早的（LRU），`exceptId` 是刚进入保活的那个，不算；
 * 正在看的页面不算（用户马上会回来发消息，回收了反而要重新启动）。
 * 候选只看 awaitingUser：正在执行的一轮它不是 true（调用方还会把还在跑的子对话、后台命令排在外面）。
 * 返回要结束的 id，从最久没用的开始；没超限返回空数组。limit 为 0 表示不限制。
 */
export function keepAliveVictims(
  list: Pick<Task, 'id' | 'awaitingUser' | 'turnSeenAt' | 'turnDoneAt' | 'updatedAt'>[],
  limit: number,
  exceptId = '',
  watched: (id: string) => boolean = () => false,
): string[] {
  if (!limit) return []
  // awaitingUser 就是「回复完停在等下一句」：正在跑的这一轮它一直是 false，天然不在候选里
  const idle = list.filter((t) => t.awaitingUser && t.id !== exceptId && !watched(t.id))
  // 刚进入保活的那一个也算进上限：已有 idle 数 + 1 超过 limit 时要收掉差的那么多。
  // 没传 exceptId（那个自己还在忙、不占名额）时不能加 1，否则会多收一个空闲会话
  const over = idle.length + (exceptId ? 1 : 0) - limit
  if (over <= 0) return []
  const used = (t: Pick<Task, 'turnSeenAt' | 'turnDoneAt' | 'updatedAt'>) =>
    t.turnSeenAt || t.turnDoneAt || t.updatedAt || ''
  return idle
    .sort((a, b) => used(a).localeCompare(used(b)))
    .slice(0, over)
    .map((t) => t.id)
}

/**
 * 回收站里的一行：设置页「回收站」只显示这几项（标题、删除时间、还剩几天，见 server/tasks.ts 的 GET /tasks/trash）。
 * 保留期的说法只由 leftDays 算，前端不再自己拿删除时间推一遍
 */
export interface TrashRow {
  id: string
  title: string
  projectId: string
  parentTaskId: string
  /** 进回收站的时间 */
  deletedAt: string
  /** 还剩几天被物理删除，0 表示下次清理就删 */
  leftDays: number
  /** 跟着一起进回收站的子对话数 */
  children: number
  /** 独立分支状态：active 的恢复后能接着用，其他没有可用的分支 */
  worktree: string
}

export function taskSummary(t: Task): Task {
  const first = t.messages.find((m) => m.role === 'user')
  return {
    ...t,
    askedAt: askedAt(t),
    messages: first ? [{ ...first, text: first.text.slice(0, 500), tools: [] }] : [],
    // brief 是父对话给的要求原文（可能上千字），列表和侧栏都读不到，跟着 output / command 一起清掉
    steps: t.steps.map(({ usage, ...s }) => ({ ...s, output: '', command: [], brief: '', changes: [] })),
    todos: [],
    plans: [],
    baseline: {},
    sessions: {},
    sessionDirs: {},
    command: [],
    workflows: [],
    // 运行记录里有共享状态和节点消息，列表用不到；但 runRunning 判定「还在跑」要看最后一条的 status / endedAt，
    // 清空就会让摘要和完整任务算出两种结果（侧栏计数、行首转圈、标题 (n) 跟着不一致）
    runs: (t.runs ?? []).slice(-1).map((r) => ({ ...r, workflows: [], skillSlots: {}, state: {}, messages: [] })),
    workflowName: t.workflowName || t.workflows.find((w) => w.id === t.workflowId)?.name || '',
  }
}

/**
 * 一段文字的短指纹（FNV-1a 32 位）。shared 里的代码前端也会打包，不能引 node:crypto。
 * 只用来判断「有没有变」，碰撞后果是漏推一次增量，不影响正确性
 */
function textKey(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/**
 * 交给父对话决定时发给它的话：带上问题全文和选项。
 * 父对话停在等下一句时，这次交付是续上同一个 CLI 调用，收件箱不会重新读；
 * 只写「问题在收件箱里」它拿不到内容，会不知道要决定什么。
 */
export function delegatePrompt(ask: { from: string; title: string; question: string; options: string[] }) {
  const options = ask.options.length
    ? `\n\n可选的做法：\n${ask.options.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
    : ''
  return `子对话「${ask.title}」在等你决定：\n${ask.question}${options}\n\n决定后用 send_to_conversation 交给它（id: ${ask.from}）。`
}

/**
 * 消息的指纹：文字、思考、工具和工具输出有变化时会变，推送增量时用来判断哪些消息要重发。
 * 提问卡片是否已回答也要算进去，否则在别处答完（父对话里点选、父对话转达）后卡片仍是「待决定」
 *
 * withOutput=false 时不算工具输出的内容指纹（只留长度）：那是「骨架」，用来判断这条消息有没有被改过，
 * 代价只看长度、不逐字符扫输出，落盘指纹的增量计算用它（见 server/task-store.ts 的 createStampTracker）
 */
export function messageStamp(m: TaskMessage, withOutput = true) {
  // delegated 也要算进指纹：交给父对话决定后服务端只改了这几个字段，不算的话卡片推不过去，会一直停在「等你选择」
  const ask = m.ask
    ? `ask:${m.ask.by ?? ''}:${m.ask.answer ?? ''}:${m.ask.delegated ? 1 : 0}:${m.ask.delegatedAt ?? ''}:${m.ask.delegatedError ?? ''}`
    : ''
  return `${m.text.length}|${m.thinking?.length ?? 0}|${m.error ? 1 : 0}|${ask}|${m.tools
    .map(
      (t) =>
        // 工具输出要带内容指纹：命令输出是按快照替换的，长度可能刚好不变（边跑边刷新的状态行），
        // 只看长度的话这一步的增量不会推送，界面要等到下一次长度变化才跳一下
        // 运行中标记、耗时也要算：停止时这一行只是收掉运行中、记上耗时，输出不变，
        // 不算进来的话这次变化推不到页面，「运行命令」那一行会一直转圈（看着像命令没停）
        `${t.output?.length ?? 0}.${withOutput && t.output ? textKey(t.output) : ''}${t.failed ? 'x' : ''}${t.running ? 'r' : ''}${t.ms !== undefined ? 'm' : ''}${t.input?.length ?? 0}`,
    )
    .join(',')}`
}

/**
 * 前端手上那份对话的版本：条数 + 最后一条消息 id。
 * 不用内容指纹：拿它对上的时候，服务端从「最后一条」开始补发，最后一条本身也重发一遍，
 * 正在流式增长的那条不会漏。SSE 重连时前端报这个版本，服务端能对上就只发增量（见 server/tasks.ts 的 /:id/events）
 */
export function taskMessageRev(messages: Pick<TaskMessage, 'id'>[]): string {
  return `${messages.length}:${messages.at(-1)?.id ?? ''}`
}

/**
 * 手上的版本是不是当前对话的前缀：是就返回要补发的起点（含最后一条，它可能还在变），不是返回 -1。
 * 对不上（消息被删、换了对话）时调用方发整份，不猜着拼
 */
export function taskRevOffset(messages: Pick<TaskMessage, 'id'>[], rev: string): number {
  const sep = rev.indexOf(':')
  if (sep < 0) return -1
  const count = Number(rev.slice(0, sep))
  if (!Number.isInteger(count) || count <= 0 || count > messages.length) return -1
  return messages[count - 1]?.id === rev.slice(sep + 1) ? count - 1 : -1
}

/**
 * 打开对话时先取最近 limit 条消息（不传 limit 就全量，老调用方照旧）；
 * before 是往前翻页的锚点：取这条之前的 limit 条
 */
export function messagePage(messages: TaskMessage[], limit = 0, before = '') {
  const total = messages.length
  // limit 不是正整数时按全量（老调用方不传参数，行为不变）
  const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, total) : total
  const end = before ? messages.findIndex((m) => m.id === before) : total
  // 锚点找不到（那条消息被返工删掉了）：不猜着给一页——给尾部会让「往前翻」一条都接不上，
  // 给最早那段会让前端把中间缺失的部分拼成不连续的对话。回一个标志，由调用方重新取最后一页
  if (end < 0) return { messages: [] as TaskMessage[], total, hasMore: true, anchorMissing: true }
  const start = Math.max(0, end - count)
  return { messages: messages.slice(start, end), total, hasMore: start > 0, anchorMissing: false }
}

/** 把一次调用的改动累加到列表里（同一个文件合并行数） */
export function mergeChanges(into: FileChange[], add: FileChange[]) {
  for (const c of add) {
    const old = into.find((x) => x.path === c.path)
    if (old) {
      old.add += c.add
      old.del += c.del
    } else into.push({ ...c })
  }
}

/**
 * 一次调用自己的改动：只统计 CLI 亲自报告的文件改动（Write、Edit 这类工具报的 file 事件）。
 * 没有报告过文件时返回空：工作区差值里混着同一工作区里并行子对话、别的任务改的文件，
 * 全算给它会让没报告文件的节点显示成「改文件 32/28」。任务级的整体改动另记在 task.changes。
 */
export function ownedChanges(since: FileChange[], touched: Set<string>): FileChange[] {
  if (!touched.size) return []
  return since.filter((c) => touched.has(c.path))
}

/**
 * 节点执行期间新增的改动：节点结束后和开始前的统计（都相对任务开始时）相减。
 * 同时在跑的节点改了同一个文件时分不清是谁改的，算在先结束的节点上
 */
export function changesSince(before: FileChange[], after: FileChange[]): FileChange[] {
  const out: FileChange[] = []
  for (const c of after) {
    const b = before.find((x) => x.path === c.path)
    const add = c.add - (b?.add ?? 0)
    const del = c.del - (b?.del ?? 0)
    if (add > 0 || del > 0) out.push({ path: c.path, add: Math.max(0, add), del: Math.max(0, del) })
  }
  return out
}

/** 节点的用量记录，没有就建一条 */
export function stepUsage(step: { usage?: StepUsage }, model = ''): StepUsage {
  return (step.usage ??= {
    context: 0,
    window: 0,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  })
}

/** 用户回答了 Agent 的提问：每个问题和答案，在对话正文里显示；没回答（交给 AI 自己决定）时为空 */
export function questionAnswers(
  req: Pick<TaskRequest, 'title' | 'questions'>,
  r: { allow: boolean; answer?: string; answers?: string[] },
): { question: string; answer: string }[] | undefined {
  if (!r.allow) return undefined
  const qs = req.questions?.length ? req.questions.map((q) => q.question) : [req.title]
  const got = r.answers?.length ? r.answers : [r.answer ?? '']
  return qs.map((question, i) => ({ question, answer: got[i] ?? '' }))
}

/**
 * 模型偶尔把工具调用的原始写法（<invoke name=…>、<parameter name=…>）当成文字说出来，
 * 内容和工具调用的折叠块重复，一大段参数堆在正文里很难看：显示时去掉。
 * 从第一个这样的标记去掉到最后一个结束标记；没有结束标记（流式输出到一半、或者只写了半截）时去掉到结尾。
 * 代码块和行内代码里的不算：那是在正经讲 XML
 */
const TOOL_OPEN =
  /<\/?(?:[\w-]+:)?(?:function_calls|invoke|parameter)\b[^>\n]*>|(?:^|(?<=\s))(?:invoke|parameter) name="[^"\n]*"[^>\n]*>/m
const TOOL_CLOSE = /<\/(?:[\w-]+:)?(?:function_calls|invoke|parameter)>/g

export function stripToolMarkup(text: string) {
  if (!/invoke|parameter|function_calls/.test(text)) return text
  // 代码换成等长的空白再找，下标和原文对得上
  const plain = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (m) => ' '.repeat(m.length))
  const open = TOOL_OPEN.exec(plain)
  if (!open) return text
  let end = text.length
  let last: RegExpExecArray | null = null
  TOOL_CLOSE.lastIndex = open.index
  for (let m = TOOL_CLOSE.exec(plain); m; m = TOOL_CLOSE.exec(plain)) last = m
  if (last) end = last.index + last[0].length
  return (text.slice(0, open.index).trimEnd() + '\n\n' + text.slice(end).trimStart()).trim()
}

/**
 * 继续执行前去掉上一轮结束时写的状态说明（已暂停、失败后可以重试）：接着跑以后它已经不成立，
 * 留着还会把同一个节点的前后输出隔成两段
 */
export function dropEndNotes(task: Pick<Task, 'messages'>) {
  while (task.messages.at(-1)?.transient) task.messages.pop()
}

/**
 * 结束这次运行：没完成的节点标成跳过，不再执行。
 * 主 Agent 是常驻编排器，一直在；之后的要求交给它处理（可以起新的一次运行）
 */
export function closeFlow(task: Task, id: string, now = new Date().toISOString()) {
  // 只结束这次运行：之前几次运行的节点已经走完，不动
  const run = currentRun(task)
  for (const s of task.steps)
    if (inRun(s.id, run) && s.status !== 'done' && s.status !== 'skipped') {
      s.status = 'skipped'
      s.interrupted = false
    }
  task.flowClosed = true
  // 用户主动结束的：不再显示成失败、暂停
  if (task.status === 'failed' || task.status === 'stopped') task.status = 'done'
  task.messages.push({
    id,
    role: 'system',
    agentId: '',
    step: '',
    text: t('这次运行已经结束，没完成的节点不再执行。之后的要求直接跟主角色说，需要时它会再走一遍流程。'),
    tools: [],
    at: now,
  })
  task.updatedAt = now
}
