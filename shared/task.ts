/** 新建任务的初始数据；真实执行和在线演示共用 */
import {
  type AskKind,
  type Attachment,
  type FileChange,
  type NewTaskInput,
  type StepUsage,
  type Task,
  type TaskData,
  type TaskMessage,
  type TaskRequest,
  type TaskTurn,
  type ToolUse,
  type Workflow,
} from './schema.ts'
import { currentRun, inRun, planTask } from './flow.ts'
import { getLang, t } from './i18n.ts'
import { openPlan } from './plan.ts'
import { attachChip, chipMarker, quoteBlock } from './composer.ts'

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
    text = text.split(ref).join(a.quote !== undefined ? `\n${quoteBlock(a.quote)}` : a.path)
    used.add(a)
  }
  const quotes = attachments.filter((a) => !used.has(a) && a.quote !== undefined)
  if (quotes.length) text = quotes.map((a) => quoteBlock(a.quote ?? '')).join('') + text
  text = text.replace(/^\n+/, '')
  const rest = attachments.filter((a) => !used.has(a) && a.quote === undefined)
  if (!rest.length) return text
  const list = rest.map((a) => `- ${a.name}：${a.path}`).join('\n')
  return `${text}\n\n## 附件\n用户附上了这些文件，需要时直接读取：\n${list}`
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
    childLimit: 0,
    wantsWorktree: false,
    inbox: [],
    workflowId: input.mode === 'workflow' ? (workflow?.id ?? '') : '',
    agentId: input.mode === 'chat' ? input.agentId : '',
    // 默认 Agent 和不用 Agent 角色的对话（agentId 为空）都能在对话时选 CLI 和模型；其他 Agent 用自己配置的
    cli: input.mode === 'chat' && canPickRun(input.agentId) ? (input.cli ?? '') : '',
    model: input.mode === 'chat' && canPickRun(input.agentId) ? (input.model ?? '') : '',
    effort: input.mode === 'chat' && canPickRun(input.agentId) ? (input.effort ?? '') : '',
    askUser: input.askUser ?? false,
    params: input.mode === 'chat' ? (input.params ?? {}) : {},
    status: 'running',
    runMs: 0,
    runStartedAt: now,
    waitMs: 0,
    waitStartedAt: '',
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
    platform: '',
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

type Pausable = { runStartedAt: string; runMs: number; waitMs: number; waitStartedAt: string }

/**
 * 执行中停在等待上（等用户确认 / 回答 / 下一句）：先把已经跑的执行时间结算进 runMs，
 * 停下的这一刻开始算等待，之后的空闲不再算执行。
 * keepAlive 让一次 CLI 调用一直不返回，不在这里断开的话整段空闲都会被算成执行时间。
 */
export function pauseRun(task: Pausable, now = Date.now()) {
  if (!task.runStartedAt) return
  task.runMs += Math.max(0, now - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
  if (!task.waitStartedAt) task.waitStartedAt = new Date(now).toISOString()
}

/** 等到了（用户回答 / 发来下一句）：等待结算进 waitMs，从这一刻继续算执行 */
export function resumeRun(task: Pausable, now = Date.now()) {
  if (task.waitStartedAt) {
    task.waitMs = (task.waitMs ?? 0) + Math.max(0, now - Date.parse(task.waitStartedAt))
    task.waitStartedAt = ''
  }
  if (!task.runStartedAt) task.runStartedAt = new Date(now).toISOString()
}

export function endRun(
  task: TurnHost & { runMs: number; runStartedAt: string; waitMs: number; waitStartedAt: string; steps: Timed[] },
  now = new Date(),
) {
  if (task.runStartedAt) task.runMs += Math.max(0, now.getTime() - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
  // 停下时还挂着的请求随这一轮结束，等待也到此为止（包含停在等待工具上的那段）
  task.waitMs = waitDuration(task, now.getTime())
  task.waitStartedAt = ''
  for (const o of task.steps) closeWait(o, now.getTime())
  for (const turn of task.turns ?? []) if (turn.status === 'running') endTurn(task, turn, 'stopped', now.getTime())
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

export function endTurn(task: TurnHost, turn: TaskTurn, status: TaskTurn['status'], now = Date.now()) {
  if (turn.status !== 'running') return
  Object.assign(turn, turnStats(task, turn, now), { status, endedAt: new Date(now).toISOString() })
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
 * 任务（含子对话）当下的阶段：列表分组、状态图标、行内状态文字都用这一套，
 * 避免列表说一个说法、点进去又是另一个。
 */
export type TaskStage = 'you' | 'running' | 'unfinished' | 'done' | 'stopped'

/**
 * 子对话离「彻底完成」还差哪几样（见 childHolds），空数组才算做完了
 */
export type ChildHold = 'working' | 'background' | 'workflow' | 'helpers' | 'plan' | 'asking' | 'requests' | 'unmerged'

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
  x: { background?: number; merged?: boolean } = {},
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
  x: { background?: number; merged?: boolean; reported?: boolean } = {},
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
  }
  return holds.map((h) => what[h]).join(t('、'))
}

/**
 * 一个任务属于哪个阶段：
 * - 有等用户确认的请求或没回答的提问 → 需要你处理
 * - 执行失败 → 需要你处理
 * - 正在跑这一轮，或者后台命令还在跑 → 执行中
 * - 用户 / 父对话主动停下 → 已停止
 * - 计划还没做完（见 shared/plan.ts 的 openPlan）→ 未完成：交付了一半，不算已完成
 * - 其余 → 已完成
 *
 * 「已停止」只认 status === 'stopped'：对话交付完一轮后 status 仍是 running，
 * 只是 working 变回 false、CLI 在等下一句，它已经做完了，不能算停止。
 * 子对话要停下来等用户时应当先提问（见内置「通用约束」），所以没在跑也没提问就等于交付完了；
 * 但计划没做完、后台命令还在跑的不算：那是真的还剩任务，别让它看起来已完成。
 * 「已标记解决」排在这几条之后：正常只在彻底完成时标记（见 childHolds），
 * 万一标早了也不能盖住还在跑、计划没做完这些事实。
 */
export function taskStage(x: {
  status: Task['status']
  /** CLI 正在处理这一轮：进程活着但在等下一句 / 预热时算 false */
  working?: boolean
  /** 子对话被标记为已解决 */
  resolved?: boolean
  /** 正在等用户确认的请求数 */
  requests?: number
  /** 还没回答的提问数 */
  asking?: number
  /** 还在跑、排队的后台命令数：有它就还在执行 */
  background?: number
  /** 工作流运行还没跑完（见 runRunning） */
  workflow?: boolean
  /** 派出去的子任务还在跑（见 helpersWorking） */
  helpers?: boolean
  /** 计划还没做完：列表里归「未完成」，不算交付完 */
  unfinished?: boolean
  /** 独立分支还没合回父对话的分支：同样是「未完成」，不能显示成已完成 */
  unmerged?: boolean
}): TaskStage {
  if (x.requests || x.asking) return 'you'
  if (x.status === 'failed') return 'you'
  if (x.working || x.background || x.workflow || x.helpers) return 'running'
  if (x.status === 'stopped' && !x.resolved) return 'stopped'
  if (x.unfinished || x.unmerged) return 'unfinished'
  return 'done'
}

/**
 * 子对话「本次开启」的时间：最近一轮开始执行的时间。
 * 做完或停下后又接到新任务会开新的一轮，它就往前走，列表里重新排到最前面；
 * 还没执行过任何一轮的按创建时间算。
 */
export function childStartedAt(t: Pick<Task, 'turns' | 'createdAt'>) {
  return t.turns.at(-1)?.startedAt || t.createdAt
}

/** 子对话列表排序要用的字段：父对话的子对话栏、悬浮窗列表都传这些进来 */
export interface ChildEntry {
  id: string
  title: string
  status: Task['status']
  working: boolean
  cliAlive: boolean
  /** 本次开启的时间，见 childStartedAt */
  startedAt: string
  /** 正在等用户确认的请求数、没回答的提问数：都算「需要你处理」 */
  requests?: number
  asking?: number
  /** 用户标记的「解决」：算已完成 */
  resolved?: boolean
  /** 还没做完的计划：「计划 7/8」，有它就不算已完成 */
  plan?: { done: number; total: number }
  /** 还在跑、排队的后台命令数：有它就算还在执行（见 childHolds） */
  background?: number
  /** 工作流运行还没跑完：转圈不能提前停（见 runRunning） */
  workflow?: boolean
  /** 派出去的子任务还在跑：转圈不能提前停（见 childHolds） */
  helpers?: boolean
  /** 独立分支还没合回父对话的分支：不算彻底完成，列表里归「未完成」（见 childHolds 的 unmerged） */
  unmerged?: boolean
}

/** 子对话这会儿在做什么：父对话的子对话栏接在名字后面显示（只有一项有值） */
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
}

/** 子对话列表里状态分类的先后：要你处理的在最上面，然后执行中、未完成、做完的、停下的 */
const stageRank: TaskStage[] = ['you', 'running', 'unfinished', 'done', 'stopped']

/** 这一条在列表里算哪个阶段：计划没做完、独立分支没合回的不算已完成（见 taskStage） */
export const childStage = (x: ChildEntry) => taskStage({ ...x, unfinished: !!x.plan && x.plan.done < x.plan.total })

/**
 * 行首要不要转圈：还没彻底完成（还在干活、计划没做完、独立分支没合回）时转，
 * 一眼看出它还在跑，不会把「未完成」当成做完了。
 * 等用户处理（提问、待确认）不转：那是在等你，转圈会把「等你选择」说成「还在跑」
 */
export const childSpinning = (x: ChildEntry) => {
  const st = childStage(x)
  return st === 'running' || st === 'unfinished'
}

/** 行首换成「等你选择」的图标：有提问 / 待确认，真在等你拍板（失败还是用失败的图标） */
export const childWaiting = (x: ChildEntry) => childStage(x) === 'you' && !!(x.asking || x.requests)

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
 */
export function runningChildren<T extends ChildEntry>(list: T[]): T[] {
  return list.filter((x) => childRunning(x))
}

/**
 * 子对话列表的顺序：先按状态分类（需要你处理 → 执行中 → 未完成 → 已完成 → 已停止），
 * 同一类里按本次开启的时间倒序（见 childStartedAt），时间一样用 id 兜底免得每次渲染抖动。
 * 排序键不取最近一条消息：执行中的输出会让列表不停跳。
 * 父对话里显示子对话、悬浮窗列表都用它；「全部」里的分组标题见 TaskView 的 childGroups，
 * 它按 list 的先后往各组里放，所以两边顺序一致。
 */
export function sortChildren<T extends ChildEntry>(list: T[]): T[] {
  return list.slice().sort((a, b) => {
    const byStage = stageRank.indexOf(childStage(a)) - stageRank.indexOf(childStage(b))
    if (byStage) return byStage
    const byStart = (b.startedAt || '').localeCompare(a.startedAt || '')
    if (byStart) return byStart
    return a.id.localeCompare(b.id)
  })
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
 * 对话派出的子任务（spawn_agents 的步骤）还在跑：CLI 这一轮已经回复完（working 已是 false），
 * 但对话停在那里等它们交回结果，在侧栏和项目首页里也算「还在跑」
 */
export function helpersWorking(t: Pick<Task, 'status' | 'steps'>) {
  return t.status === 'running' && t.steps.some((s) => s.slot === 'sub' && s.status === 'running')
}

/** 列表里的「执行中」：自己在执行、名下子对话在执行、在等它派出的子任务，或者工作流运行还没跑完 */
export function taskBusy(t: Pick<Task, 'status' | 'steps' | 'working' | 'childrenWorking'> & { runs?: Task['runs'] }) {
  return t.working || !!t.childrenWorking || helpersWorking(t) || runRunning(t)
}

export function taskSummary(t: Task): Task {
  const first = t.messages.find((m) => m.role === 'user')
  return {
    ...t,
    askedAt: askedAt(t),
    messages: first ? [{ ...first, text: first.text.slice(0, 500), tools: [] }] : [],
    steps: t.steps.map(({ usage, ...s }) => ({ ...s, output: '', command: [], changes: [] })),
    todos: [],
    plans: [],
    baseline: {},
    sessions: {},
    command: [],
    workflows: [],
    // 运行记录里有共享状态和节点消息，列表用不到；任务页会取完整内容
    runs: [],
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
 * 消息的指纹：文字、思考、工具和工具输出有变化时会变，推送增量时用来判断哪些消息要重发。
 * 提问卡片是否已回答也要算进去，否则在别处答完（父对话里点选、父对话转达）后卡片仍是「待决定」
 */
export function messageStamp(m: TaskMessage) {
  const ask = m.ask ? `ask:${m.ask.by ?? ''}:${m.ask.answer ?? ''}` : ''
  return `${m.text.length}|${m.thinking?.length ?? 0}|${m.error ? 1 : 0}|${ask}|${m.tools
    .map(
      (t) =>
        // 工具输出要带内容指纹：命令输出是按快照替换的，长度可能刚好不变（边跑边刷新的状态行），
        // 只看长度的话这一步的增量不会推送，界面要等到下一次长度变化才跳一下
        `${t.output?.length ?? 0}.${t.output ? textKey(t.output) : ''}${t.failed ? 'x' : ''}${t.input?.length ?? 0}`,
    )
    .join(',')}`
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
