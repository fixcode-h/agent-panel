/**
 * 执行引擎：按流程图调度节点，真实执行和模拟执行共用。
 *
 * - 从「开始」出发，一个节点的上游全部完成后才执行，没有依赖关系的节点同时执行
 * - 节点可以挂三个流程入口：开始（结果作为初始资料）、验收（不通过就把意见交回节点继续完善）、
 *   结束（结果并入节点输出）；也可以整个节点就是执行另一个流程
 * - 每个节点在 task.steps 里有一条记录，id 是路径（`n1/review.2/n5`），也用作 CLI 会话键；
 *   续跑时已完成的节点直接复用输出
 * - 主 Agent 调度（工作流打开 dispatch 时）：每次执行一个工作流都有一个主 Agent（`@main` 节点，一个续接的会话），
 *   子 Agent 的节点完成后交给它评估（通过 / 退回 / 委派其他工作流 / 停下），条件连线由它选路，流程结束时它整理结果。
 *   调用另一个工作流时那个工作流有自己的主 Agent，挂在发起的节点下面，任务进度里就是主 Agent → 子 Agent 的层级
 * - 节点执行中可以通过编排工具（Orchestra，真实执行由 server/orch-mcp.ts 交给 CLI）派子 Agent 并行处理、
 *   查各 Agent 的状态、向主 Agent 提问、给别的 Agent 传话；派出的子 Agent 挂在节点下面（`n1/sub/h1`）
 *
 * 怎么调用一个 Agent 由宿主决定（server/exec/runner.ts 调用 CLI，shared/runner.ts 生成示例输出）。
 */
import type { ReviewTarget } from './clis.ts'
import { commonAgents } from './agent-role.ts'
import {
  END,
  START,
  type Agent,
  type Flow,
  type FlowNode,
  type FlowEdge,
  type FlowRef,
  type NodeStep,
  type NodeTier,
  type ParamValues,
  type RunMessage,
  type RunStateEntry,
  type Task,
  type TaskRun,
  type TaskStep,
  type Workflow,
} from './schema.ts'
import {
  blankStep,
  currentRun,
  entryFlow,
  flowLabel,
  inRun,
  nodeAgent,
  nodeSteps,
  parallelTo,
  planTask,
  preds,
  reachable,
  resolveRef,
  runPrefix,
  stepTree,
  topoOrder,
  topSteps,
  workflowClosure,
  MAIN_STEP,
  dispatches,
  isMainStep,
  mainStep,
  blockedStep,
  reopenFlow,
  taskFlow,
} from './flow.ts'
import {
  dispatchText,
  evaluateEvent,
  firstPlanEvent,
  mainDuties,
  parseDispatch,
  planEvent,
  questionEvent,
  stripDispatch,
  summaryEvent,
  type Dispatch,
} from './dispatch.ts'
import { t } from './i18n.ts'
import { beginTurn, endTurn, pauseStep, withAttachments } from './task.ts'
import { DEFAULT_WORKFLOW_ID } from './builtin/default.ts'

/** 提示词里的流程入口名，固定用中文（提示词不跟随界面语言） */
const SLOT_PROMPT: Record<string, string> = {
  start: '开始',
  review: '验收',
  end: '结束',
  body: '执行',
  step: '步骤',
  sub: '子 Agent',
  call: '委派',
}

/** 节点提示词里节点自己的部分从这里开始，前面是同一个任务里各节点共用的部分 */
export const NODE_PART = '## 当前节点'

export type AgentResult =
  | { ok: true; text: string }
  /** stopped：用户停止；halted：别的节点失败了，这里没再继续（节点保持待执行，续跑时重来） */
  | { ok: false; stopped?: boolean; halted?: boolean; error: string; reported?: boolean; budget?: boolean }
type Fail = Extract<AgentResult, { ok: false }>

export interface AgentCall {
  /** 所属节点；追加要求和对话没有节点 */
  step?: TaskStep
  agentId: string
  prompt: string
  /** CLI 会话键：节点用节点 id，对话和追加要求用 Agent id */
  sessionKey: string
  /** 这次调用是在验收（模拟执行据此给出验收结论） */
  reviewing?: boolean
  /** 节点后面有条件连线，要给出「结论：通过 / 不通过」（模拟执行据此给出结论） */
  deciding?: boolean
  /** 会话续不上时（CLI 清理了历史）改用的完整提示；prompt 只是续接用的简短要求时才需要 */
  fresh?: string
  /** 不是普通的一轮：压缩上下文，或者审查代码 */
  op?: { kind: 'compact' } | { kind: 'review'; target: ReviewTarget }
  /** 工作流里的调用：用默认 CLI 的这一档（空表示按 Agent 设的档位）；对话不传，用 Agent 自己的设置 */
  tier?: NodeTier
  /** Agent 参数的值（节点上填的）；不传时对话用任务里选的 */
  params?: ParamValues
  /** 主 Agent 的调度轮：评估节点、整理最终结果、回答子 Agent 的提问、决定用户新要求怎么处理（模拟执行据此给出示例输出） */
  dispatching?: 'evaluate' | 'summary' | 'answer' | 'plan'
  /** 工作流里的调用都带编排工具：派子 Agent、查状态、提问、传话（真实执行交给 CLI 的 MCP） */
  orch?: Orchestra
  /** 预热：打开对话页时先用 --resume 启动，只等下一句，不算一轮、不记输出 */
  prewarm?: boolean
}

/** 派一个子 Agent 的要求 */
export interface HelperSpec {
  title: string
  instructions: string
  /** Agent 的名字或 id；不写用发起的节点的 Agent */
  agent?: string
  /** 默认 CLI 的档位；不写跟发起的节点 */
  tier?: string
}

/** 子 Agent 的状态（wait_agents 的结果） */
export interface HelperReport {
  id: string
  title: string
  status: TaskStep['status']
  output?: string
  error?: string
}

/**
 * 交给一次调用的编排工具，绑定在调用它的节点上。工具调用不能等太久（Codex 默认 60 秒就超时），
 * 等子 Agent、等主 Agent 回答都有上限，没等到就先返回，之后再查
 */
export interface Orchestra {
  /** 调用者的节点 id */
  self: string
  /** 这个工作流有没有主 Agent 调度（没有时不能提问） */
  hasMain: boolean
  /** 这条调用是不是常驻编排器自己的（只有它能起停运行） */
  planner: boolean
  /** 可以直接派的通用 Agent（名字和简介），spawn_agents 里列出来 */
  common: { name: string; description: string }[]
  status(): string
  spawn(tasks: HelperSpec[]): { ids: string[]; error?: string }
  wait(ids: string[], ms: number): Promise<{ done: HelperReport[]; running: HelperReport[] }>
  ask(question: string, ms: number): Promise<{ answer?: string; pending?: boolean; error?: string }>
  send(to: string, text: string): Promise<{ ok: boolean; info: string }>
  inbox(): string[]
  /** 起一次新的运行：节点全部新建，按流程图执行。同一次运行里不能嵌套起运行 */
  run(input: string): { ok: boolean; info: string }
  /** 结束这次运行：没完成的节点不再执行，之后的要求由编排器直接处理 */
  closeRun(): { ok: boolean; info: string }
  /** 对话 Agent：可以把一次工作流运行排到这一轮后面，跑完再继续对话 */
  planning: boolean
  plan(workflowId: string, input: string): { ok: boolean; info: string }
  /** 协调 Agent：能不能创建 / 给子对话发消息 */
  coordinator: boolean
  conversations(): Promise<string>
  createConversation(
    title: string,
    message: string,
    files?: string[],
  ): Promise<{ ok: boolean; id?: string; info: string }>
  sendToConversation(id: string, message: string): Promise<{ ok: boolean; info: string }>
  /** 子对话（连同它的工作流节点）：和父对话通讯、认领要改的文件；子对话之间不能直接通讯 */
  child: boolean
  /** 子对话和兄弟共用目录、需要认领文件（独立分支里的不用） */
  claims: boolean
  /** 对话（项目对话、子对话）：长命令交给面板在后台跑，跑完把结果推回这个对话 */
  canBackground: boolean
  runBackground(input: { command: string; name: string; cwd: string; exclusive: boolean }): Promise<{
    ok: boolean
    info: string
  }>
  checkBackground(id: string): string
  /** 独立分支里的子对话：把改动交给面板合回原目录编译（排队，结果推回来） */
  canSubmit: boolean
  submitBuild(note: string): Promise<{ ok: boolean; info: string }>
  toParent(text: string, question: boolean): Promise<{ ok: boolean; info: string }>
  claim(paths: string[]): { ok: boolean; info: string }
  release(paths: string[]): { ok: boolean; info: string }
  /** 本次运行的共享状态：读快照 / 写一个键 */
  readState(): string
  writeState(key: string, value: string): { ok: boolean; info: string }
}

export interface EngineHost {
  task: Task
  agents: Agent[]
  /** 所有工作流（节点可以引用其他工作流） */
  workflows: Workflow[]
  workflow?: Workflow
  /** 本轮的用户输入 */
  prompt: string
  /**
   * 项目设置和本机环境里已经确认的授权，写进每次调用的公共部分：
   * 推送策略（ask 第一次问、allow 直接推、deny 一律不推）、这个对话里用户已经做的选择、
   * 以及已经授权可用的外部工具（gh、cloudflared 等，只列已登录的）
   */
  policy?: {
    push: 'ask' | 'allow' | 'deny'
    /** 这个对话里用户对推送的回答 */
    answered?: 'allowed' | 'denied'
    /** 已安装并登录的外部工具 */
    tools: string[]
  }
  /** 这一轮是「继续流程」，不是新的要求：停在某个节点结论上的流程从那个节点重新检查后接着走 */
  resume?: boolean
  /** 预热：打开对话页时后台启动 CLI，不算一轮；失败时回到 prewarmFrom */
  prewarm?: boolean
  prewarmFrom?: Task['status']
  /** 预热开始前的 turnDoneAt：结束时没变说明没有处理新消息 */
  prewarmTurnDoneAt?: string
  changed: (flush?: boolean) => void
  newId: () => string
  runAgent: (call: AgentCall) => Promise<AgentResult>
  /**
   * 节点完成后等用户确认（节点勾了「完成后等我确认」）：返回用户的决定，停止时返回 null。
   * 没有时（例如在线演示之外的宿主不支持）不等待，直接往下走
   */
  confirm?: (step: TaskStep, text: string) => Promise<{ allow: boolean; answer?: string } | null>
  /** 节点结果太长时把完整内容存成文件，返回文件路径，下游节点自己去读；没有时只截断 */
  saveHandoff?: (step: TaskStep, text: string) => Promise<string>
  /** 有节点失败或用户停止后置位：所有层级的流程都不再启动新节点、新一轮验收 */
  halted?: boolean
  /** 把一段话交给正在跑的节点（CLI 支持执行中补充时）；交不了返回 false，改放进它的收件箱 */
  steer?: (stepId: string, text: string) => Promise<boolean>
  /** 项目里可选的工作流目录：启动计划时 Agent 按名称、说明和节点概览挑一个 */
  workflowCatalog?: () => { id: string; name: string; description: string; steps: string[] }[]
  /**
   * 写文件的格式（项目设置优先，没设时跟随全局），写进公共部分让 Agent 照着做；
   * 不传时说明文件不带这一段（在线演示）
   */
  fileFormat?: { encoding: 'utf8' | 'utf8-bom'; eol: 'lf' | 'crlf' }
  /** 按 id 取工作流和这次运行要用的快照、技能槽；id 为空表示项目的默认工作流 */
  resolveWorkflow?: (
    id: string,
  ) => { workflow: Workflow; workflows: Workflow[]; skillSlots: Record<string, string> } | undefined
  /** 子对话列表：协调 Agent 判断这条消息该交给哪个子对话 */
  listConversations?: () => Promise<{ id: string; title: string; status: string; summary: string; at: string }[]>
  /** 新建子对话并异步执行，返回后父对话继续；完成后由宿主把结果回报到父对话 */
  createConversation?: (input: {
    title: string
    message: string
    agentId?: string
    /** 父对话划给这个子对话的文件 / 目录：创建时替它认领 */
    files?: string[]
  }) => Promise<{ ok: boolean; id?: string; title?: string; info: string }>
  /** 给已有子对话追加消息并异步执行 */
  sendToConversation?: (id: string, message: string) => Promise<{ ok: boolean; info: string }>
  /** 子对话怎么隔离（项目设置里选）：worktree 各自独立分支、合回原目录编译，claim 共用目录认领文件 */
  childIsolation?: 'claim' | 'worktree'
  /** 独立分支里的子对话：提交编译（面板排队试合并、跑合并时编译的步骤，结果推回子对话） */
  submitBuild?: (note: string) => Promise<{ ok: boolean; info: string }>
  /**
   * 后台命令：面板在这个对话的目录里跑，马上返回编号；跑完把结果推回对话（正在执行就插话，空闲就开新的一轮）。
   * exclusive 的（编译这类）按项目排队，同一时间只跑一个
   */
  runBackground?: (input: { command: string; name: string; cwd: string; exclusive: boolean }) => Promise<{
    ok: boolean
    info: string
  }>
  /** 查后台命令：不传编号列出这个对话的全部 */
  checkBackground?: (id: string) => string
  /**
   * 父对话发布的全局规则（「/rule」）：子对话和它的工作流节点每次调用都带上，必须遵守。
   * 父对话自己也带上，分派时提醒子对话
   */
  rules?: string[]
  /** 父对话在对话设置里写的目标：父对话和子对话都看得到 */
  goal?: string
  /** 父对话：子对话发来、上一轮之后还没读的消息（读一次就清掉） */
  takeInbox?: () => { title: string; text: string }[]
  /** 子对话：给父对话发消息（汇报进展、提问）；question 表示需要父对话决定 */
  messageParent?: (text: string, question: boolean) => Promise<{ ok: boolean; info: string }>
  /** 子对话：认领 / 释放要改的文件（同一父对话下的子对话共用一个目录） */
  claimFiles?: (paths: string[]) => { granted: string[]; held: { path: string; by: string }[] }
  releaseFiles?: (paths: string[]) => number
}

const MAX_DEPTH = 6
const MAX_OUTPUT = 4000
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const now = () => new Date().toISOString()

/** 这次运行的工作流运行记录（新架构按运行隔离共享状态和消息）；旧任务没有 */
function runRecord(task: Task): TaskRun | undefined {
  const run = currentRun(task)
  return (task.runs ?? []).find((r) => r.id === run)
}

/** 这次运行里所有节点共享的键值状态 */
function runState(task: Task): Record<string, RunStateEntry> {
  return runRecord(task)?.state ?? {}
}

/** 交给节点的共享状态快照：并发节点开始前读一次，执行中也可以用 read_state 再读 */
function statePart(task: Task) {
  const entries = Object.entries(runState(task))
  if (!entries.length) return ''
  const lines = entries.slice(0, 50).map(([k, v]) => {
    const who = v.by || '未知节点'
    return `- ${k}（v${v.version}，${who} 写入）：${clip(v.value, 1200)}`
  })
  return `## 共享状态\n这是本次运行里所有节点共同维护的状态，可以用 read_state / write_state 读写；写之前先看版本，别覆盖别人刚写的内容：\n${clip(lines.join('\n'), 12000)}`
}

/** 这次运行的记录：新架构在启动运行时建；旧版工作流任务也在开始执行时补一条，共享状态和消息才有地方存 */
function ensureTaskRun(host: EngineHost, workflow: Workflow, run: number, skillSlots = host.task.skillSlots) {
  const has = host.task.runs.find((r) => r.id === run)
  if (has) return has
  const rec: TaskRun = {
    id: run,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflows: host.workflows.length ? host.workflows : [workflow],
    skillSlots,
    status: 'running',
    startedAt: now(),
    endedAt: '',
    state: {},
    messages: [],
  }
  host.task.runs.push(rec)
  return rec
}

/** 写共享状态：版本号加一，后写的覆盖先写的 */
function writeRunState(host: EngineHost, by: string, key: string, value: string) {
  const rec = runRecord(host.task)
  if (!rec) return { ok: false, info: '这次运行没有共享状态（可能是旧版对话），直接写在结果里交给下游节点' }
  const k = key.trim().slice(0, 80)
  if (!k) return { ok: false, info: 'key 不能为空' }
  const old = rec.state[k]
  const version = (old?.version ?? 0) + 1
  rec.state[k] = { value: clip(value, 20000), version, by, at: now() }
  host.changed(true)
  return { ok: true, version, info: `已写入「${k}」v${version}` }
}

/** 一次运行的收件箱：没读过的消息，读完记下来，历史仍留在运行记录里 */
function runMail(host: EngineHost, id: string) {
  const rec = runRecord(host.task)
  if (!rec) return []
  const got = rec.messages.filter((m) => m.to === id && !m.read)
  for (const m of got) m.read = true
  if (got.length) host.changed()
  return got.map((m) => m.text)
}

/** 节点之间发消息：并发节点执行中能互相提醒，消息按运行保存，重启后还能看到 */
function sendRunMessage(host: EngineHost, from: string, to: string, text: string) {
  const rec = runRecord(host.task)
  if (!rec) return false
  const msg: RunMessage = { id: host.newId(), from, to, text: clip(text, 20000), read: false, at: now() }
  rec.messages.push(msg)
  host.changed(true)
  return true
}

/** 节点 / 步骤的输出：太长时另存文件，交给下游的结果里写明去哪读 */
async function storeOutput(host: EngineHost, step: TaskStep, text: string) {
  let out = clip(text, MAX_OUTPUT)
  if (text.length > MAX_OUTPUT && host.saveHandoff) {
    const file = await host.saveHandoff(step, text).catch(() => '')
    if (file) out += `\n\n（完整结果有 ${text.length} 字，这里只附了开头。完整内容在文件 ${file}，开始之前请先读完。）`
  }
  return out
}

/** 一次流程调用：在哪个工作流的哪个流程，挂在哪个节点的哪个入口下 */
interface Invocation {
  workflow: Workflow
  flow: Flow
  parentId: string
  slot: TaskStep['slot']
  round: number
  /** 流程的输入：主流程是用户需求，入口流程是发起节点交过来的资料 */
  input: string
  /** 入口流程的发起节点标题 */
  owner?: string
  depth: number
  /** 第几次运行：同一个对话里工作流可以按顺序跑多次，节点 id 按它隔离 */
  run: number
  /** 调度这个流程的主 Agent；同一工作流里的子流程、入口流程沿用发起它的那个 */
  main?: MainCtl
}

/** 一次工作流执行的主 Agent：一个节点、一个续接的会话，调度轮一轮接一轮（同一个会话不能同时跑两轮） */
interface MainCtl {
  step: TaskStep
  workflow: Workflow
  flow: Flow
  chain: Promise<unknown>
  /** 是不是外层还有流程（结果交回上一级，不是直接给用户） */
  nested: boolean
}

type FlowResult = { ok: true; output: string } | Fail

/**
 * 从验收输出里读结论（也用于条件连线的「结论」）；没写结论时视为通过。
 * 给 Agent 的提示词（节点说明、验收要求、结论格式）固定用中文，不跟界面语言走：结论靠固定的说法识别，
 * 提示词跟着界面换语言，换语言前后的工作流行为就会不一样。英文的「verdict: pass/fail」也认，模型偶尔会这样写
 */
export function parseVerdict(text: string): 'pass' | 'fail' | '' {
  const all = [...text.matchAll(/结论\s*[:：]\s*\**\s*(不通过|通过)/g)]
  if (all.length) return all.at(-1)![1] === '通过' ? 'pass' : 'fail'
  const en = [...text.matchAll(/verdict\s*[:：]\s*(pass|fail)/gi)]
  if (en.length) return en.at(-1)![1].toLowerCase() === 'pass' ? 'pass' : 'fail'
  return ''
}

export function system(host: EngineHost, text: string, step = '', error = false, transient = false) {
  host.task.messages.push({
    id: host.newId(),
    role: 'system',
    agentId: '',
    step,
    text,
    tools: [],
    ...(error && { error }),
    ...(transient && { transient }),
    at: now(),
  })
}

/** 这一轮用掉的花费和 token 超过工作流的上限时，返回暂停的说明 */
function overBudget(host: EngineHost): string {
  const w = host.workflow
  const { usage, budgetFrom } = host.task
  const usd = usage.costUsd - (budgetFrom?.usd ?? 0)
  const tokens = usage.inputTokens + usage.outputTokens - (budgetFrom?.tokens ?? 0)
  if (w?.budgetUsd && usd >= w.budgetUsd)
    return t('这次执行已经花了 ${used}，达到工作流设定的上限 ${limit}，已暂停。点「继续执行」会再给一份同样的额度。', {
      used: usd.toFixed(2),
      limit: w.budgetUsd.toFixed(2),
    })
  if (w?.budgetTokens && tokens >= w.budgetTokens)
    return t(
      '这次执行已经用了 {used} token，达到工作流设定的上限 {limit}，已暂停。点「继续执行」会再给一份同样的额度。',
      {
        used: Math.round(tokens).toLocaleString(),
        limit: w.budgetTokens.toLocaleString(),
      },
    )
  return ''
}

function userRequests(task: Task) {
  // 和实际交给 CLI 的一样：文字里的附件引用换成路径，没引用的列在后面
  const users = task.messages
    .filter((m) => m.role === 'user' && !m.step)
    .map((m) => withAttachments(m.prompt || m.text, m.attachments))
  return { original: users[0] ?? '', extra: users.slice(1) }
}

const stepPath = (inv: Invocation, nodeId: string) =>
  inv.parentId
    ? `${inv.parentId}/${inv.slot}${inv.round ? `.${inv.round}` : ''}/${nodeId}`
    : `${runPrefix(inv.run)}${nodeId}`

function ensureStep(host: EngineHost, inv: Invocation, node: FlowNode, index: number): TaskStep {
  const id = stepPath(inv, node.id)
  let step = host.task.steps.find((s) => s.id === id)
  if (!step) {
    // 多步节点：节点记录只负责展示和汇总，执行者按第一步算
    const first = nodeSteps(node)[0]
    step = blankStep({
      id,
      parentId: inv.parentId,
      slot: inv.parentId ? inv.slot : '',
      round: inv.round,
      workflowId: inv.workflow.id,
      flowId: inv.flow.id,
      nodeId: node.id,
      kind: first.kind,
      title: node.title.trim() || t('节点 {n}', { n: index + 1 }),
      agentId: first.kind === 'agent' ? nodeAgent(inv.workflow, first.agentId) : '',
    })
    host.task.steps.push(step)
  }
  return step
}

/** 节点里一步的执行记录：旧节点用节点记录本身，显式步骤用 `<节点>/step/<步骤 id>` */
function ensureUnitStep(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  record: TaskStep,
  unit: NodeStep,
  index: number,
): TaskStep {
  if (!node.steps.length) return record
  const id = `${record.id}/step/${unit.id}`
  let step = host.task.steps.find((s) => s.id === id)
  if (!step) {
    step = blankStep({
      id,
      parentId: record.id,
      slot: 'step',
      workflowId: inv.workflow.id,
      flowId: inv.flow.id,
      nodeId: unit.id,
      kind: unit.kind,
      title: unitTitle(host, inv, unit, index),
      agentId: unit.kind === 'agent' ? nodeAgent(inv.workflow, unit.agentId) : '',
    })
    host.task.steps.push(step)
  }
  return step
}

/** 显式步骤显示的名字：没写标题时用 Agent / 流程的名字 */
function unitTitle(host: EngineHost, inv: Invocation, unit: NodeStep, index: number) {
  if (unit.title.trim()) return unit.title.trim()
  if (unit.kind === 'flow') {
    const target = resolveRef(unit.flow, inv.workflow, host.workflows)
    return target ? t('调用流程「{name}」', { name: flowLabel(target.flow, target.workflow) }) : t('调用流程')
  }
  return (
    host.agents.find((a) => a.id === nodeAgent(inv.workflow, unit.agentId))?.name ?? t('步骤 {n}', { n: index + 1 })
  )
}

/** 节点重跑：显式步骤的所有记录和消息一起删掉，从第一步重新开始 */
function dropNodeSteps(host: EngineHost, step: TaskStep) {
  const drop = new Set(
    stepTree(host.task, step.id)
      .filter((s) => s.id.slice(step.id.length + 1).split('/')[0] === 'step')
      .map((s) => s.id),
  )
  if (!drop.size) return
  host.task.steps = host.task.steps.filter((s) => !drop.has(s.id))
  host.task.messages = host.task.messages.filter((m) => !drop.has(m.step))
}

/**
 * 节点重跑时删掉要重新来的子节点和它们的消息：验收、结束，以及验收不通过后的返工轮次（body.N）。
 * 开始流程和第一轮的流程节点已完成的部分可以复用。
 */
function dropRerun(host: EngineHost, step: TaskStep) {
  const drop = new Set(
    stepTree(host.task, step.id)
      .filter((s) => {
        const seg = s.id.slice(step.id.length + 1).split('/')[0]
        return /^(review|end|call)(\.\d+)?$/.test(seg) || /^body\.\d+$/.test(seg) || seg === 'sub'
      })
      .map((s) => s.id),
  )
  if (!drop.size) return
  host.task.steps = host.task.steps.filter((s) => !drop.has(s.id))
  host.task.messages = host.task.messages.filter((m) => !drop.has(m.step))
}

/**
 * 同一轮执行里的授权情况：项目设置的推送策略、这个对话里用户已经做过的选择、本机已经登录的外部工具。
 * 只写已经具备的能力，没装的、没授权的不要列出来，免得模型去试。
 */
function policyPart(host: EngineHost) {
  const p = host.policy
  if (!p) return ''
  const push =
    p.push === 'deny'
      ? '推送：这个项目不允许推送到远端，只做本地提交 / pending；需要推送时告诉用户去项目设置里改。'
      : p.answered === 'denied'
        ? '推送：这个对话里用户已经拒绝过推送，这次不要再问，也不要推。'
        : p.answered === 'allowed' || p.push === 'allow'
          ? '推送：这次可以推送到远端（用户已经授权）；推送前确认分支和远端，推完回读确认。'
          : '推送：第一次需要推送时先用提问工具问用户一次（推荐「允许这次推送」和「只做本地提交」），按回答做，这个对话里不再重复问。'
  const tools = p.tools.length
    ? `已经授权可用的工具：${p.tools.join('、')}（直接用，不要重新登录）。`
    : '本机没有检测到可用的外部授权工具（例如 gh），需要时请用户先自己登录。'
  return `## 授权情况\n${push}\n${tools}`
}

/** 对话的目标：用户在父对话设置里写的，父对话按它取舍，子对话知道自己这部分是为了什么 */
function goalPart(host: EngineHost) {
  const goal = host.goal?.trim()
  if (!goal) return ''
  return host.task.parentTaskId
    ? `## 父对话的目标\n${clip(goal, 4000)}\n你做的是其中一部分，取舍时以这个目标为准。`
    : `## 这个对话的目标\n${clip(goal, 4000)}\n判断要不要做、做到哪一步、怎么分派时以这个目标为准。`
}

/** 父对话发布的全局规则：子对话和它的所有节点都要遵守；父对话自己看到的是「你发布的」 */
function rulesPart(host: EngineHost) {
  const rules = (host.rules ?? []).map((r) => r.trim()).filter(Boolean)
  if (!rules.length) return ''
  const list = rules.map((r, i) => `${i + 1}. ${clip(r, 2000)}`).join('\n')
  return host.task.parentTaskId
    ? `## 全局规则（父对话发布，必须遵守）\n${list}\n和其他要求冲突时以这些规则为准；做不到的地方用 message_parent 告诉父对话，不要自己绕过。`
    : `## 这个对话的全局规则\n你和用户在这个对话里发布的规则，所有子对话都会收到并遵守：\n${list}`
}

/** 父对话：上一轮之后子对话发来的消息（汇报、提问），这一轮一起处理 */
function inboxPart(host: EngineHost) {
  const got = host.takeInbox?.() ?? []
  if (!got.length) return ''
  return `## 子对话发来的消息\n${got.map((m) => `- 「${m.title}」：${clip(m.text, 2000)}`).join('\n')}\n需要回复的用 send_to_conversation 交回给对应的子对话。`
}

/**
 * 写文件的格式：项目设置在全局设置里定的编码和换行符。
 * 说清楚是为了避免 Windows 上写出的 CRLF / BOM 让脚本在 WSL / Linux 里跑不起来。
 */
function fileFormatPart(host: EngineHost) {
  const f = host.fileFormat
  if (!f) return ''
  const enc = f.encoding === 'utf8-bom' ? 'UTF-8（带 BOM）' : 'UTF-8（不带 BOM）'
  const eol = f.eol === 'crlf' ? 'CRLF（Windows）' : 'LF'
  const tip =
    f.eol === 'lf' && f.encoding === 'utf8'
      ? '这样在 WSL / Linux 里执行带 shebang 的脚本不会报 bad interpreter。'
      : '和项目设置保持一致，不要自己改成别的换行符。'
  return `## 文件格式\n新建或改写的文本文件统一用 ${enc}、换行符 ${eol}。${tip}\n已经有文件的编码和换行符不要批量转换，只改这次任务涉及的内容。`
}

/**
 * 同一个任务里各个节点（包括主 Agent、派出的子 Agent）都一样的开头：需求、工作流说明、通用要求。
 * 放在最前面，按前缀匹配缓存的模型服务（Codex 等）能多命中一段
 */
/**
 * 独立分支里的子对话（连同它的工作流节点）：分支只用来隔离改文件，里面没有编译产物和依赖的构建结果，
 * 编译、构建这类步骤交给面板合回原目录统一跑，不在这里跑
 */
function buildPart(host: EngineHost) {
  if (!host.submitBuild) return ''
  return `## 编译交给面板
你在独立分支的目录里改文件，这里只隔离编辑：不要在这里跑编译、构建、打包或会写构建产物的命令（UE 的 Build.bat、npm run build 这类），也不要为了编译去装依赖。
- 可以跑不写构建产物的快速检查：类型检查、lint、单个文件的语法检查。
- 改完一批后调用 submit_build：面板把改动排队合回原目录，按项目里标了「合并时编译」的步骤编译，通过才算合进去；失败会撤回，并把报错推回给你，在这里修好再提交一次。
- 提交后不用干等，可以接着做别的部分；结果到了再处理。没有编译通过，不说完成。`
}

/** 能用后台命令时说清楚什么时候用：不说的话模型照样同步跑长命令，一直卡着 */
function backgroundPart(host: EngineHost) {
  if (!host.runBackground) return ''
  return `## 长命令放到后台
预计超过一分钟的命令（完整测试、端到端测试、长时间的检查${host.submitBuild ? '' : '、编译'}）用 run_background 交给面板在后台跑，它马上返回，结果跑完会自动推回给你：
- 等结果的时候接着做不依赖它的事：读代码、写文档、改和这条命令无关的文件。不要改这条命令要检查的文件，改了结果就不算数（面板会标出期间被改过）。
- 编译、打包这类会抢文件锁的命令把 exclusive 设为 true，面板按项目排队，同一时间只跑一个。
- 手上没有别的事时直接结束这一轮，结果到了会接着处理；不要反复调用 check_background 轮询。
- 几秒就能跑完的命令照常直接执行。`
}

function commonPart(host: EngineHost, w?: Workflow) {
  const { original, extra } = userRequests(host.task)
  return [
    `## 用户需求\n${original}`,
    extra.length ? `## 用户的补充要求\n${extra.map((t) => `- ${t}`).join('\n')}` : '',
    w?.document.trim() ? `## 工作流说明\n${w.document.trim()}` : '',
    statePart(host.task),
    policyPart(host),
    goalPart(host),
    rulesPart(host),
    buildPart(host),
    fileFormatPart(host),
    '## 通用要求\n完成后用中文简要总结：做了什么、改了哪些文件、有没有遗留问题。\n' +
      // 一次输出太长时，模型服务的连接容易中途断开，整个节点白做
      '写很长的文件时分几次写：先写开头一部分，再分段追加或编辑补上，每次不超过约 300 行；不要一次输出整个大文件。',
  ]
}

function unitPrompt(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  unit: NodeStep,
  step: TaskStep,
  input: string,
  start: string,
  deciding: boolean,
  multi: boolean,
) {
  const name = (id: string) => host.agents.find((a) => a.id === id)?.name ?? '主 Agent'
  const siblings = parallelTo(inv.flow, node.id)
  const reviewing = inv.slot === 'review'
  const target = (id: string) =>
    id === END ? '结束' : `「${inv.flow.nodes.find((n) => n.id === id)?.title || '未命名节点'}」`
  const branches = inv.flow.edges.filter((e) => e.from === node.id && e.when)
  const route = (w: 'pass' | 'fail') =>
    branches
      .filter((e) => e.when === w)
      .map((e) => target(e.to))
      .join('、')
  // 顺序按「越稳定越靠前」排：同一个任务里各个节点都一样的（需求、工作流说明、通用要求）放在最前面，
  // 节点自己的（标题、要做的事、上游结果）放在后面。按前缀匹配缓存的模型服务（Codex 等）这样能多命中一段
  return [
    ...commonPart(host, inv.workflow),
    `${NODE_PART}\n你正在执行工作流「${inv.workflow.name}」里流程「${flowLabel(inv.flow, inv.workflow)}」的节点：${multi ? `${node.title.trim() || step.title} · ` : ''}${step.title}` +
      (inv.owner
        ? `\n这个流程是节点「${inv.owner}」的${SLOT_PROMPT[inv.slot]}流程${reviewing ? `（第 ${inv.round} 轮验收）` : ''}。`
        : ''),
    unit.instructions.trim() ? `## 本${multi ? '步' : '节点'}要做的事\n${unit.instructions.trim()}` : '',
    start ? `## 开始流程的结果（作为本节点的初始资料）\n${start}` : '',
    input ? `## 输入\n${input}` : '',
    siblings.length
      ? `## 同时进行的节点\n下面这些节点可能和你同时执行，不要做它们的工作，也尽量不要改同一个文件：\n${siblings
          .map((s) => {
            const first = nodeSteps(s)[0]
            return `- ${s.title || '未命名节点'}（${first.kind === 'flow' ? '调用流程' : name(nodeAgent(inv.workflow, first.agentId))}）`
          })
          .join('\n')}`
      : '',
    `## 要求\n只完成本${multi ? '步' : '节点'}「${step.title}」，不要做其他${multi ? '步骤' : '节点'}的工作。`,
    reviewing
      ? '你在验收上面「输入」里的结果。逐条检查，不通过时列出必须修改的地方。最后单独一行写「验收结论：通过」或「验收结论：不通过」。'
      : '',
    deciding
      ? `## 结论\n后面的流程按你的结论走${route('pass') ? `：通过时接着做${route('pass')}` : ''}${route('fail') ? `；不通过时接着做${route('fail')}` : ''}。完成后最后单独一行写「结论：通过」或「结论：不通过」。`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 上一轮同一个节点的 CLI 会话：验收流程第 N 轮接第 N-1 轮，流程节点返工（body.2、body.3…）接上一轮（第一轮是 body）。
 * 其他情况（第一轮、开始和结束流程）返回空
 */
function prevRoundSession(host: EngineHost, inv: Invocation, kind: NodeStep['kind'], nodeId: string, stepId?: string) {
  if (!inv.parentId || kind !== 'agent') return ''
  // 返工轮次从 2 开始编号，第一轮是 0（路径里不带轮次）
  const prev =
    inv.slot === 'review' && inv.round > 1
      ? inv.round - 1
      : inv.slot === 'body' && inv.round >= 2
        ? inv.round === 2
          ? 0
          : inv.round - 1
        : -1
  if (prev < 0) return ''
  const base = stepPath({ ...inv, round: prev }, nodeId)
  return host.task.sessions[stepId ? `${base}/step/${stepId}` : base] ?? ''
}

/** 续接上一轮会话时的提示：只交这一轮的输入，其余要求上一轮已经给过 */
function nextRoundPrompt(inv: Invocation, step: TaskStep, input: string) {
  const what =
    inv.slot === 'review'
      ? `这是第 ${inv.round} 轮验收：被验收的节点按上一轮的意见修改过了，下面是修改后的结果。请在上一轮检查的基础上重新逐条验收，确认上一轮提出的问题都已解决、没有引入新的问题。最后单独一行写「验收结论：通过」或「验收结论：不通过」。`
      : `上一轮的结果需要修改，下面是这一轮的输入。请在你上一轮工作的基础上继续完善本节点「${step.title}」，完成后同样简要总结。`
  return [what, input ? `## 输入\n${input}` : ''].filter(Boolean).join('\n\n')
}

/** 执行一个节点：有显式步骤时逐步串行，旧节点仍走原来的单执行者逻辑 */
async function runNode(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  index: number,
  outputs: Map<string, { title: string; text: string }>,
): Promise<FlowResult> {
  if (node.steps.length) return runNodeSteps(host, inv, node, index, outputs)
  return runNodeSingle(host, inv, node, index, outputs)
}

/** 执行一个单执行者节点（含开始、验收、结束入口） */
async function runNodeSingle(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  index: number,
  outputs: Map<string, { title: string; text: string }>,
): Promise<FlowResult> {
  const step = ensureStep(host, inv, node, index)
  if (step.status === 'done') return { ok: true, output: step.output }
  if (host.halted) return { ok: false, halted: true, error: '' }
  // 上次执行到一半被打断、CLI 会话还在：续接会话接着做，不从头再来
  const resumeHalf = step.interrupted && !!host.task.sessions[step.id] && node.kind === 'agent'
  step.interrupted = false
  if (!resumeHalf) {
    dropRerun(host, step)
    // 重新执行：耗时和等待从头算；续接时接着之前做的时间累加
    step.spentMs = 0
    step.waitMs = 0
  }
  step.status = 'running'
  step.startedAt = now()
  step.endedAt = ''
  step.verdict = ''
  step.rounds = 0
  host.changed(true)

  const ups = preds(inv.flow, node.id)
  const upstream = ups
    .filter((p) => p !== START)
    .map((p) => outputs.get(p))
    .filter(Boolean)
    .map((o) => `### ${o!.title}\n${o!.text || '（没有文字输出）'}`)
  // 节点开始前别的 Agent 发给它的消息（主 Agent 的指示、其他子 Agent 的传话）
  const mail = takeMail(host, step.id)
  const input = [
    ups.includes(START) && inv.input ? inv.input : '',
    upstream.length ? `上游节点的结果：\n\n${upstream.join('\n\n')}` : '',
    mail.length ? `## 收到的消息\n${mail.map((m) => `- ${m}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const sub = (ref: FlowRef | null, slot: TaskStep['slot'], round: number, subInput: string) =>
    runRef(host, inv, ref, { parentId: step.id, slot, round, input: subInput, owner: step.title })

  const fail = (r: Fail): FlowResult => {
    step.status = r.stopped || r.halted ? 'pending' : 'failed'
    // 被停止时已经做了一部分，记下来，继续执行时续接会话
    step.interrupted = !!r.stopped && !!host.task.sessions[step.id]
    if (r.stopped || r.halted) pauseStep(step)
    step.endedAt = now()
    // 错误写进出错的节点里，打开节点就能看到；外层节点和整个任务的结尾只提一句，不重复整段
    if (!r.stopped && !r.halted && !r.reported) {
      system(host, r.error || t('执行失败'), step.id, true)
      r = { ...r, reported: true }
    }
    host.changed(true)
    return r
  }

  // 开始流程
  let start = ''
  if (node.hooks.start) {
    const r = await sub(
      node.hooks.start,
      'start',
      0,
      [`节点「${step.title}」准备开始。`, node.instructions.trim(), input].filter(Boolean).join('\n\n'),
    )
    if (!r.ok)
      return fail({
        ...r,
        error: r.stopped ? r.error : t('「{title}」的开始流程失败：{error}', { title: step.title, error: r.error }),
      })
    start = r.output
  }

  // 预算：这一轮的花费或 token 超过工作流设定的上限就暂停，免得验收来回循环一直烧钱
  const over = overBudget(host)
  if (over) return fail({ ok: false, stopped: true, budget: true, error: over })

  // 后面有条件连线：按结论选路。有主 Agent 评估时由主 Agent 选，否则要求节点自己给出结论
  const branchy = inv.flow.edges.some((e) => e.from === node.id && e.when)
  const evaluates = mainEvaluates(inv, node, branchy)
  const deciding = node.kind === 'agent' && branchy && !evaluates
  const orch = makeOrchestra(host, { workflow: inv.workflow, main: inv.main, tier: node.tier }, step)

  // 节点本身；返工时 round 往上加（流程节点的返工按 round 区分子节点）
  let bodyRound = 1
  const body = async (round: number, extra: string): Promise<AgentResult> => {
    if (node.kind === 'flow') {
      const r = await sub(
        node.flow,
        'body',
        round,
        [input, start ? `开始流程的结果：\n${start}` : '', extra].filter(Boolean).join('\n\n'),
      )
      return r.ok ? { ok: true, text: r.output } : r
    }
    if (!step.agentId)
      return { ok: false, error: t('「{title}」没有可执行的角色，请先给工作流选择主角色', { title: step.title }) }
    const full = unitPrompt(
      host,
      inv,
      node,
      nodeSteps(node)[0],
      step,
      input,
      start,
      deciding && inv.slot !== 'review',
      false,
    )
    // 验收的第 2 轮起、流程节点返工的子节点：续接上一轮同一个节点的会话，只交这一轮的新输入。
    // 上一轮读过的代码、给过的意见都在会话里，整段历史能命中缓存；不续接的话每轮都从头读一遍
    const prev =
      round === 0 && !resumeHalf && !host.task.sessions[step.id] ? prevRoundSession(host, inv, node.kind, node.id) : ''
    if (prev) host.task.sessions[step.id] = prev
    const cont =
      round === 0 && resumeHalf
        ? `上次执行到一半被中断了（停止或面板重启）。请检查已经做了哪些，从中断的地方接着完成本节点「${step.title}」的工作，完成后同样简要总结。`
        : prev
          ? nextRoundPrompt(inv, step, input)
          : ''
    const tail = deciding && (extra || cont) ? '\n\n最后同样单独一行写「结论：通过」或「结论：不通过」。' : ''
    const call = (prompt: string) =>
      host.runAgent({
        step,
        agentId: step.agentId,
        prompt,
        fresh: extra || cont ? [full, extra].filter(Boolean).join('\n\n') : undefined,
        sessionKey: step.id,
        reviewing: inv.slot === 'review',
        deciding,
        tier: node.tier,
        params: node.params,
        orch,
      })
    let r = await call((extra || cont || full) + tail)
    // 失败自动重试（CLI 断线、偶发错误）：续接同一个会话，让它检查做到哪了接着做
    for (let i = 0; i < node.retries && !r.ok && !r.stopped && !r.halted && !r.budget && !host.halted; i++) {
      system(
        host,
        t('「{title}」执行失败，自动重试（第 {n} 次）：{error}', {
          title: step.title,
          n: i + 1,
          error: clip(r.error, 300),
        }),
        step.id,
      )
      host.changed(true)
      r = await call(
        `上一次执行失败了：${clip(r.error, 1000)}\n\n请检查已经做了哪些，接着完成本节点「${step.title}」的工作，完成后同样简要总结。${tail}`,
      )
    }
    if (!r.ok) return r
    // 节点派出去的子 Agent 是它工作的一部分：等它们都结束；它自己没取回的结果并进节点的输出
    const late = await settleHelpers(host, step)
    return late ? { ok: true, text: `${r.text}\n\n## 子 Agent 的结果\n${late}` } : r
  }
  const rework = (agentText: string, flowText: string) => body(++bodyRound, node.kind === 'flow' ? flowText : agentText)
  let r = await body(0, '')
  if (!r.ok) return fail(r)
  let text = r.text

  // 验收：不通过就把意见交回节点，每次最多 maxRounds 轮；用户退回后重新验收，轮次接着编号
  let reviewRound = 0
  const review = async (): Promise<Fail | null> => {
    if (!node.hooks.review) return null
    for (let n = 1; ; n++) {
      const round = ++reviewRound
      const rv = await sub(
        node.hooks.review,
        'review',
        round,
        `被验收的节点：${step.title}\n\n## 这个节点要做的事\n${node.instructions.trim() || '（没有写）'}\n\n## 它的结果\n${text || '（没有文字输出）'}`,
      )
      if (!rv.ok)
        return {
          ...rv,
          error: rv.stopped
            ? rv.error
            : t('「{title}」的验收流程失败：{error}', { title: step.title, error: rv.error }),
        }
      const verdict = parseVerdict(rv.output)
      step.rounds = round
      step.verdict = verdict === 'fail' ? 'fail' : 'pass'
      if (!verdict)
        system(host, t('「{title}」的验收流程没有写「验收结论」，按通过处理。', { title: step.title }), step.id)
      host.changed(true)
      if (verdict !== 'fail') return null
      if (host.halted) return { ok: false, halted: true, error: '' }
      if (n >= node.hooks.maxRounds)
        return {
          ok: false,
          error: t('「{title}」验收 {round} 轮仍未通过。最后一轮的意见：\n{feedback}', {
            title: step.title,
            round: n,
            feedback: clip(rv.output, 1500),
          }),
        }
      system(
        host,
        t('「{title}」第 {round} 轮验收未通过，已把意见交回节点继续完善。', { title: step.title, round }),
        step.id,
      )
      const again = overBudget(host)
      if (again) return { ok: false, stopped: true, budget: true, error: again }
      const fb = await rework(
        `验收没有通过（第 ${round} 轮）。验收意见：\n${rv.output}\n\n请按意见继续完善本节点「${step.title}」的工作，完成后同样简要总结。`,
        `上一轮的结果没有通过验收，意见：\n${rv.output}`,
      )
      if (!fb.ok) return fb
      text = fb.text
    }
  }

  for (;;) {
    const rf = await review()
    if (rf) return fail(rf)
    // 完成后等用户确认：通过就往下走；退回时带着意见返工，再验收、再确认
    if (!node.hooks.confirm || !host.confirm) break
    if (host.halted) return fail({ ok: false, halted: true, error: '' })
    const c = await host.confirm(step, text)
    if (!c) return fail({ ok: false, stopped: true, error: t('已停止') })
    if (c.allow) break
    const fb = await rework(
      `用户看了结果，要求修改：\n${c.answer || '（没有写具体意见）'}\n\n请按要求继续完善本节点「${step.title}」的工作，完成后同样简要总结。`,
      `用户看了上一轮的结果，要求修改：\n${c.answer || '（没有写具体意见）'}`,
    )
    if (!fb.ok) return fail(fb)
    text = fb.text
  }

  // 主 Agent 评估：通过（可以选分支、交代后续）、退回修改、委派另一个工作流、停下
  if (evaluates) {
    const main = inv.main!
    let reworks = 0
    let delegations = 0
    let extra = ''
    const agentName =
      node.kind === 'flow' ? t('调用流程') : (host.agents.find((a) => a.id === step.agentId)?.name ?? '')
    for (let n = 1; ; n++) {
      if (host.halted) return fail({ ok: false, halted: true, error: '' })
      const ev = await mainTurn(
        host,
        main,
        'evaluate',
        evaluateEvent({
          title: step.title,
          agent: agentName,
          instructions: node.instructions,
          result: clip(text, 8000),
          round: n,
          reworksLeft: node.hooks.maxRounds - reworks,
          branches: branchy
            ? { pass: branchTargets(inv, node, 'pass'), fail: branchTargets(inv, node, 'fail') }
            : undefined,
          extra,
        }),
      )
      if (!ev.ok)
        return fail(
          ev.stopped || ev.halted
            ? ev
            : { ...ev, error: t('主角色评估「{title}」失败：{error}', { title: step.title, error: ev.error }) },
        )
      let d: Dispatch | null = parseDispatch(ev.text)
      if (!d) {
        system(host, t('主角色没有写调度决定，「{title}」按通过处理。', { title: step.title }), step.id)
        d = { action: 'continue' }
      }
      // 退回次数用完、委派来回太多次：只能继续或停下
      if (d.action === 'rework' && reworks >= node.hooks.maxRounds)
        return fail({
          ok: false,
          error: t('主角色退回「{title}」{n} 次后仍不满意：{feedback}', {
            title: step.title,
            n: reworks,
            feedback: clip(d.feedback, 1500),
          }),
        })
      if (d.action === 'delegate' && (delegations >= MAX_DELEGATIONS || n > node.hooks.maxRounds + MAX_DELEGATIONS + 2))
        d = { action: 'continue' }
      system(host, dispatchText(d, step.title), step.id)
      host.changed(true)
      if (d.action === 'stop') return fail({ ok: false, error: dispatchText(d, step.title), reported: true })
      if (d.action === 'rework') {
        reworks++
        const fb = await rework(
          `主 Agent 评估后要求修改：\n${d.feedback || '（没有写具体意见）'}\n\n请按意见继续完善本节点「${step.title}」的工作，完成后同样简要总结。`,
          `主 Agent 评估上一轮的结果后要求修改：\n${d.feedback || '（没有写具体意见）'}`,
        )
        if (!fb.ok) return fail(fb)
        text = fb.text
        extra = ''
        continue
      }
      if (d.action === 'delegate') {
        const want = d.workflow
        const target = host.workflows.find((w) => w.id === want) ?? host.workflows.find((w) => w.name === want)
        if (!target || target.id === inv.workflow.id) {
          extra = `### 委派没有执行\n找不到可以委派的工作流「${want}」，请直接决定。`
          continue
        }
        delegations++
        const r = await sub(
          { kind: 'workflow', id: target.id },
          'call',
          delegations,
          [
            d.input || `处理和节点「${step.title}」相关的事`,
            `## 节点「${step.title}」的结果\n${clip(text, 6000)}`,
          ].join('\n\n'),
        )
        if (!r.ok)
          return fail({
            ...r,
            error: r.stopped
              ? r.error
              : t('「{title}」委派的工作流「{name}」失败：{error}', {
                  title: step.title,
                  name: target.name,
                  error: r.error,
                }),
          })
        extra = `### 委派给工作流「${target.name}」的结果\n${clip(r.output, 6000)}`
        continue
      }
      const ok = d.action === 'continue' ? d : undefined
      if (branchy) step.branch = ok?.branch ?? 'pass'
      if (ok?.note) text = `${text}\n\n主 Agent 的交代：${ok.note}`
      break
    }
  }

  // 条件连线按节点的结论选路；没写结论时按通过处理
  if (deciding) {
    const v = parseVerdict(text)
    step.branch = v === 'fail' ? 'fail' : 'pass'
    if (!v) system(host, t('「{title}」没有写「结论」，按通过处理。', { title: step.title }), step.id)
  }

  // 结束流程
  if (node.hooks.end) {
    if (host.halted) return fail({ ok: false, halted: true, error: '' })
    const e = await sub(
      node.hooks.end,
      'end',
      0,
      `节点「${step.title}」已完成，它的结果：\n${text || '（没有文字输出）'}`,
    )
    if (!e.ok)
      return fail({
        ...e,
        error: e.stopped ? e.error : t('「{title}」的结束流程失败：{error}', { title: step.title, error: e.error }),
      })
    if (e.output) text = `${text}\n\n结束流程的结果：\n${e.output}`
  }

  step.output = clip(text, MAX_OUTPUT)
  // 架构方案、测试的失败清单经常比交接上限长：完整内容存成文件，交给下游的结果里写明去哪读
  if (text.length > MAX_OUTPUT && host.saveHandoff) {
    const file = await host.saveHandoff(step, text).catch(() => '')
    if (file)
      step.output += `\n\n（完整结果有 ${text.length} 字，这里只附了开头。完整内容在文件 ${file}，开始之前请先读完。）`
  }
  step.status = 'done'
  step.endedAt = now()
  host.changed(true)
  return { ok: true, output: step.output }
}

/**
 * 执行一个多步骤节点：节点记录只做汇总，每一步一条 `slot=step` 记录和一个独立的会话，
 * 上一步的输出作为下一步的输入，任一步失败就停下
 */
async function runNodeSteps(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  index: number,
  outputs: Map<string, { title: string; text: string }>,
): Promise<FlowResult> {
  const step = ensureStep(host, inv, node, index)
  if (step.status === 'done') return { ok: true, output: step.output }
  if (host.halted) return { ok: false, halted: true, error: '' }
  // 被打断过：保留已完成的步骤，只续接没做完的；否则整个节点重跑
  const resume = step.interrupted
  step.interrupted = false
  if (!resume) {
    dropNodeSteps(host, step)
    step.spentMs = 0
    step.waitMs = 0
  }
  step.status = 'running'
  step.startedAt = now()
  step.endedAt = ''
  step.verdict = ''
  step.rounds = 0
  host.changed(true)

  const ups = preds(inv.flow, node.id)
  const upstream = ups
    .filter((p) => p !== START)
    .map((p) => outputs.get(p))
    .filter(Boolean)
    .map((o) => `### ${o!.title}\n${o!.text || '（没有文字输出）'}`)
  const mail = takeMail(host, step.id)
  const input = [
    ups.includes(START) && inv.input ? inv.input : '',
    upstream.length ? `上游节点的结果：\n\n${upstream.join('\n\n')}` : '',
    mail.length ? `## 收到的消息\n${mail.map((m) => `- ${m}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const fail = (r: Fail, at?: TaskStep): FlowResult => {
    const target = at && at !== step ? at : undefined
    if (target) {
      target.status = r.stopped || r.halted ? 'pending' : 'failed'
      target.interrupted = !!r.stopped && !!host.task.sessions[target.id]
      if (r.stopped || r.halted) pauseStep(target)
      target.endedAt = now()
    }
    step.status = r.stopped || r.halted ? 'pending' : 'failed'
    // 被打断过的多步节点保留已完成的步骤，续跑时不重跑
    step.interrupted = !!r.stopped
    if (r.stopped || r.halted) pauseStep(step)
    step.endedAt = now()
    if (!r.stopped && !r.halted && !r.reported) {
      system(host, r.error || t('执行失败'), (target ?? step).id, true)
      r = { ...r, reported: true }
    }
    host.changed(true)
    return r
  }

  // 节点级开始流程：结果作为第一步的初始资料
  let start = ''
  if (node.hooks.start) {
    const r = await runRef(host, inv, node.hooks.start, {
      parentId: step.id,
      slot: 'start',
      round: 0,
      input: [`节点「${step.title}」准备开始。`, node.instructions.trim(), input].filter(Boolean).join('\n\n'),
      owner: step.title,
    })
    if (!r.ok)
      return fail({
        ...r,
        error: r.stopped ? r.error : t('「{title}」的开始流程失败：{error}', { title: step.title, error: r.error }),
      })
    start = r.output
  }

  const over = overBudget(host)
  if (over) return fail({ ok: false, stopped: true, budget: true, error: over })

  const units = node.steps
  const branchy = inv.flow.edges.some((e) => e.from === node.id && e.when)
  const evaluates = mainEvaluatesUnits(inv, units, branchy)
  const deciding = branchy && !evaluates && units[units.length - 1].kind === 'agent'

  const records: TaskStep[] = []
  const texts: string[] = []
  const halves: boolean[] = []
  const bodyRounds = units.map(() => 1)
  const recordOf = (i: number) => {
    records[i] ??= ensureUnitStep(host, inv, node, step, units[i], i)
    return records[i]
  }
  const prepare = (i: number): 'skip' | 'go' => {
    const unit = units[i]
    const r = recordOf(i)
    if (r.status === 'done') {
      texts[i] = r.output
      return 'skip'
    }
    const half = r.interrupted && !!host.task.sessions[r.id] && unit.kind === 'agent'
    halves[i] = half
    r.interrupted = false
    if (!half) {
      dropRerun(host, r)
      r.spentMs = 0
      r.waitMs = 0
    }
    r.status = 'running'
    r.startedAt = now()
    r.endedAt = ''
    r.verdict = ''
    r.rounds = 0
    r.output = ''
    host.changed(true)
    return 'go'
  }
  const body = async (i: number, round: number, extra: string): Promise<AgentResult> => {
    const unit = units[i]
    const r = recordOf(i)
    const before = i === 0 ? input : records[i - 1]?.output || texts[i - 1] || ''
    if (unit.kind === 'flow') {
      const res = await runRef(host, inv, unit.flow, {
        parentId: r.id,
        slot: 'body',
        round,
        input: [before, i === 0 && start ? `开始流程的结果：\n${start}` : '', extra].filter(Boolean).join('\n\n'),
        owner: r.title,
      })
      return res.ok ? { ok: true, text: res.output } : res
    }
    if (!r.agentId)
      return { ok: false, error: t('「{title}」没有可执行的角色，请先给工作流选择主角色', { title: r.title }) }
    const decidingHere = deciding && i === units.length - 1 && inv.slot !== 'review'
    const full = unitPrompt(host, inv, node, unit, r, before, i === 0 ? start : '', decidingHere, true)
    const prev =
      round === 0 && !halves[i] && !host.task.sessions[r.id]
        ? prevRoundSession(host, inv, unit.kind, node.id, unit.id)
        : ''
    if (prev) host.task.sessions[r.id] = prev
    const cont =
      round === 0 && halves[i]
        ? `上次执行到一半被中断了（停止或面板重启）。请检查已经做了哪些，从中断的地方接着完成这一步「${r.title}」的工作，完成后同样简要总结。`
        : prev
          ? nextRoundPrompt(inv, r, before)
          : ''
    const tail = decidingHere && (extra || cont) ? '\n\n最后同样单独一行写「结论：通过」或「结论：不通过」。' : ''
    const call = (prompt: string) =>
      host.runAgent({
        step: r,
        agentId: r.agentId,
        prompt,
        fresh: extra || cont ? [full, extra].filter(Boolean).join('\n\n') : undefined,
        sessionKey: r.id,
        reviewing: inv.slot === 'review',
        deciding: decidingHere,
        tier: unit.tier,
        params: unit.params,
        orch: makeOrchestra(host, { workflow: inv.workflow, main: inv.main, tier: unit.tier }, r),
      })
    let res = await call((extra || cont || full) + tail)
    // 失败自动重试（CLI 断线、偶发错误）：续接这一步自己的会话
    for (let n = 0; n < unit.retries && !res.ok && !res.stopped && !res.halted && !res.budget && !host.halted; n++) {
      system(
        host,
        t('「{title}」执行失败，自动重试（第 {n} 次）：{error}', {
          title: r.title,
          n: n + 1,
          error: clip(res.error, 300),
        }),
        r.id,
      )
      host.changed(true)
      res = await call(
        `上一次执行失败了：${clip(res.error, 1000)}\n\n请检查已经做了哪些，接着完成这一步「${r.title}」的工作，完成后同样简要总结。${tail}`,
      )
    }
    if (!res.ok) return res
    const late = await settleHelpers(host, r)
    return late ? { ok: true, text: `${res.text}\n\n## 子 Agent 的结果\n${late}` } : res
  }

  const reworkText = (i: number, agentText: string, flowText: string) =>
    body(i, ++bodyRounds[i], units[i].kind === 'flow' ? flowText : agentText)

  /** 这一步的验收：不通过就带着意见重做这一步，轮次独立 */
  const reviewUnit = async (i: number): Promise<Fail | null> => {
    const unit = units[i]
    const r = recordOf(i)
    if (!unit.review) return null
    for (let n = 1; ; n++) {
      const round = ++r.rounds
      const rv = await runRef(host, inv, unit.review, {
        parentId: r.id,
        slot: 'review',
        round,
        input: `被验收的节点：${r.title}\n\n## 这一步要做的事\n${unit.instructions.trim() || '（没有写）'}\n\n## 它的结果\n${texts[i] || '（没有文字输出）'}`,
        owner: r.title,
      })
      if (!rv.ok)
        return {
          ...rv,
          error: rv.stopped ? rv.error : t('「{title}」的验收流程失败：{error}', { title: r.title, error: rv.error }),
        }
      const verdict = parseVerdict(rv.output)
      r.rounds = round
      r.verdict = verdict === 'fail' ? 'fail' : 'pass'
      if (!verdict) system(host, t('「{title}」的验收流程没有写「验收结论」，按通过处理。', { title: r.title }), r.id)
      host.changed(true)
      if (verdict !== 'fail') return null
      if (host.halted) return { ok: false, halted: true, error: '' }
      if (n >= unit.maxRounds)
        return {
          ok: false,
          error: t('「{title}」验收 {round} 轮仍未通过。最后一轮的意见：\n{feedback}', {
            title: r.title,
            round: n,
            feedback: clip(rv.output, 1500),
          }),
        }
      system(host, t('「{title}」第 {round} 轮验收未通过，已把意见交回节点继续完善。', { title: r.title, round }), r.id)
      const again = overBudget(host)
      if (again) return { ok: false, stopped: true, budget: true, error: again }
      const fb = await reworkText(
        i,
        `验收没有通过（第 ${round} 轮）。验收意见：\n${rv.output}\n\n请按意见继续完善这一步「${r.title}」的工作，完成后同样简要总结。`,
        `上一轮的结果没有通过验收，意见：\n${rv.output}`,
      )
      if (!fb.ok) return fb
      texts[i] = fb.text
    }
  }

  /** 这一步完成后等用户确认：退回时只重做这一步 */
  const confirmUnit = async (i: number): Promise<Fail | 'rework' | null> => {
    const unit = units[i]
    const r = recordOf(i)
    if (!unit.confirm || !host.confirm) return null
    if (host.halted) return { ok: false, halted: true, error: '' }
    const c = await host.confirm(r, texts[i])
    if (!c) return { ok: false, stopped: true, error: t('已停止') }
    if (c.allow) return null
    const fb = await reworkText(
      i,
      `用户看了结果，要求修改：\n${c.answer || '（没有写具体意见）'}\n\n请按要求继续完善这一步「${r.title}」的工作，完成后同样简要总结。`,
      `用户看了上一轮的结果，要求修改：\n${c.answer || '（没有写具体意见）'}`,
    )
    if (!fb.ok) return fb
    texts[i] = fb.text
    return 'rework'
  }
  // 按顺序执行；某一步失败或停止，后面的步骤不再启动
  for (let i = 0; i < units.length; i++) {
    if (prepare(i) === 'skip') continue
    if (host.halted) return fail({ ok: false, halted: true, error: '' }, recordOf(i))
    const b = overBudget(host)
    if (b) return fail({ ok: false, stopped: true, budget: true, error: b }, recordOf(i))
    const r = await body(i, 0, '')
    if (!r.ok) return fail(r, recordOf(i))
    texts[i] = r.text
    for (;;) {
      const rf = await reviewUnit(i)
      if (rf) return fail(rf, recordOf(i))
      const cf = await confirmUnit(i)
      if (cf && cf !== 'rework') return fail(cf, recordOf(i))
      if (cf === 'rework') continue
      break
    }
    const rec = recordOf(i)
    rec.output = await storeOutput(host, rec, texts[i])
    rec.status = 'done'
    rec.endedAt = now()
    host.changed(true)
  }

  const last = units.length - 1
  let text = texts[last] ?? ''

  // 主 Agent 评估：用最后一步的结果，退回时只重做最后一步
  if (evaluates) {
    const main = inv.main!
    let reworks = 0
    let delegations = 0
    let extra = ''
    const agentName =
      units[last].kind === 'flow'
        ? t('调用流程')
        : (host.agents.find((a) => a.id === recordOf(last).agentId)?.name ?? '')
    for (let n = 1; ; n++) {
      if (host.halted) return fail({ ok: false, halted: true, error: '' }, recordOf(last))
      const ev = await mainTurn(
        host,
        main,
        'evaluate',
        evaluateEvent({
          title: step.title,
          agent: agentName,
          instructions: units[last].instructions,
          result: clip(text, 8000),
          round: n,
          reworksLeft: units[last].maxRounds - reworks,
          branches: branchy
            ? { pass: branchTargets(inv, node, 'pass'), fail: branchTargets(inv, node, 'fail') }
            : undefined,
          extra,
        }),
      )
      if (!ev.ok)
        return fail(
          ev.stopped || ev.halted
            ? ev
            : { ...ev, error: t('主角色评估「{title}」失败：{error}', { title: step.title, error: ev.error }) },
          recordOf(last),
        )
      let d: Dispatch | null = parseDispatch(ev.text)
      if (!d) {
        system(host, t('主角色没有写调度决定，「{title}」按通过处理。', { title: step.title }), step.id)
        d = { action: 'continue' }
      }
      // 退回次数用完、委派来回太多次：只能继续或停下
      if (d.action === 'rework' && reworks >= units[last].maxRounds)
        return fail(
          {
            ok: false,
            error: t('主角色退回「{title}」{n} 次后仍不满意：{feedback}', {
              title: step.title,
              n: reworks,
              feedback: clip(d.feedback, 1500),
            }),
          },
          recordOf(last),
        )
      if (
        d.action === 'delegate' &&
        (delegations >= MAX_DELEGATIONS || n > units[last].maxRounds + MAX_DELEGATIONS + 2)
      )
        d = { action: 'continue' }
      system(host, dispatchText(d, step.title), step.id)
      host.changed(true)
      if (d.action === 'stop')
        return fail({ ok: false, error: dispatchText(d, step.title), reported: true }, recordOf(last))
      if (d.action === 'rework') {
        reworks++
        const fb = await reworkText(
          last,
          `主 Agent 评估后要求修改：\n${d.feedback || '（没有写具体意见）'}\n\n请按意见继续完善这一步「${step.title}」的工作，完成后同样简要总结。`,
          `主 Agent 评估上一轮的结果后要求修改：\n${d.feedback || '（没有写具体意见）'}`,
        )
        if (!fb.ok) return fail(fb, recordOf(last))
        texts[last] = fb.text
        text = fb.text
        const rec = recordOf(last)
        rec.output = await storeOutput(host, rec, fb.text)
        rec.status = 'done'
        rec.endedAt = now()
        extra = ''
        continue
      }
      if (d.action === 'delegate') {
        const want = d.workflow
        const target = host.workflows.find((w) => w.id === want) ?? host.workflows.find((w) => w.name === want)
        if (!target || target.id === inv.workflow.id) {
          extra = `### 委派没有执行\n找不到可以委派的工作流「${want}」，请直接决定。`
          continue
        }
        delegations++
        const r = await runRef(
          host,
          inv,
          { kind: 'workflow', id: target.id },
          {
            parentId: step.id,
            slot: 'call',
            round: delegations,
            input: [
              d.input || `处理和节点「${step.title}」相关的事`,
              `## 节点「${step.title}」的结果\n${clip(text, 6000)}`,
            ].join('\n\n'),
            owner: step.title,
          },
        )
        if (!r.ok)
          return fail(
            {
              ...r,
              error: r.stopped
                ? r.error
                : t('「{title}」委派的工作流「{name}」失败：{error}', {
                    title: step.title,
                    name: target.name,
                    error: r.error,
                  }),
            },
            recordOf(last),
          )
        extra = `### 委派给工作流「${target.name}」的结果\n${clip(r.output, 6000)}`
        continue
      }
      const ok = d.action === 'continue' ? d : undefined
      if (branchy) step.branch = ok?.branch ?? 'pass'
      if (ok?.note) text = `${text}\n\n主 Agent 的交代：${ok.note}`
      break
    }
  }

  // 条件连线按节点的结论选路；没写结论时按通过处理
  if (deciding) {
    const v = parseVerdict(text)
    step.branch = v === 'fail' ? 'fail' : 'pass'
    if (!v) system(host, t('「{title}」没有写「结论」，按通过处理。', { title: step.title }), step.id)
  }

  // 结束流程接收最后一步的输出
  if (node.hooks.end) {
    if (host.halted) return fail({ ok: false, halted: true, error: '' })
    const e = await runRef(host, inv, node.hooks.end, {
      parentId: step.id,
      slot: 'end',
      round: 0,
      input: `节点「${step.title}」已完成，它的结果：\n${text || '（没有文字输出）'}`,
      owner: step.title,
    })
    if (!e.ok)
      return fail({
        ...e,
        error: e.stopped ? e.error : t('「{title}」的结束流程失败：{error}', { title: step.title, error: e.error }),
      })
    if (e.output) text = `${text}\n\n结束流程的结果：\n${e.output}`
  }

  step.output = await storeOutput(host, step, text)
  step.status = 'done'
  step.endedAt = now()
  host.changed(true)
  return { ok: true, output: step.output }
}

/** 执行引用的流程 */
async function runRef(
  host: EngineHost,
  from: Invocation,
  ref: FlowRef | null,
  o: Pick<Invocation, 'parentId' | 'slot' | 'round' | 'input' | 'owner'>,
): Promise<FlowResult> {
  const target = resolveRef(ref, from.workflow, host.workflows)
  if (!target) return { ok: false, error: t('引用的流程不存在，可能已被删除') }
  if (from.depth >= MAX_DEPTH)
    return { ok: false, error: t('流程嵌套超过 {max} 层，请检查是否循环引用', { max: MAX_DEPTH }) }
  const inv: Invocation = {
    ...o,
    workflow: target.workflow,
    flow: target.flow,
    depth: from.depth + 1,
    run: from.run,
    main: from.main,
  }
  if (target.workflow.id === from.workflow.id) return runFlow(host, inv)
  // 另一个工作流：流程节点调用它、主 Agent 委派给它时，它有自己的主 Agent（挂在发起的节点下面）。
  // 开始 / 验收 / 结束入口只要它的结果（验收要的是「验收结论」），不另开主 Agent
  inv.main =
    (o.slot === 'body' || o.slot === 'call') && dispatches(target.workflow, target.flow)
      ? openMain(host, inv)
      : undefined
  return runInvocation(host, inv)
}

// ---- 主 Agent 调度 ----

/** 一个工作流的一次执行最多委派几次 */
const MAX_DELEGATIONS = 2

/**
 * 这个节点完成后要不要交给主 Agent 评估：子 Agent 做的节点、调用另一个工作流的节点、后面有条件连线的节点。
 * 主 Agent 自己做的节点不再评估自己；验收、开始、结束入口里的节点属于发起节点的验证，也不评估；
 * 带验收流程、完成后等用户确认的节点已经有人把关，也不评估（有条件连线时仍由主 Agent 选路）
 */
function mainEvaluates(inv: Invocation, node: FlowNode, branchy: boolean) {
  if (!inv.main || inv.main.workflow.id !== inv.workflow.id) return false
  if (inv.slot !== '' && inv.slot !== 'body' && inv.slot !== 'call') return false
  if (branchy) return true
  // 已经有验收流程把过关、或者你亲自确认过的节点，主 Agent 不再评估一遍：省一轮，也不和验收意见打架
  if (node.hooks.review || node.hooks.confirm) return false
  if (node.kind === 'flow') return node.flow?.kind === 'workflow'
  return nodeAgent(inv.workflow, node.agentId) !== inv.workflow.mainAgentId
}

/** 多步节点要不要交给主 Agent 评估：任何一步配了验收 / 确认就不再重复评估 */
function mainEvaluatesUnits(inv: Invocation, units: NodeStep[], branchy: boolean) {
  if (!inv.main || inv.main.workflow.id !== inv.workflow.id) return false
  if (inv.slot !== '' && inv.slot !== 'body' && inv.slot !== 'call') return false
  if (branchy) return true
  if (units.some((u) => u.review || u.confirm)) return false
  const last = units[units.length - 1]
  if (last.kind === 'flow') return last.flow?.kind === 'workflow'
  return nodeAgent(inv.workflow, last.agentId) !== inv.workflow.mainAgentId
}

/** 条件连线通向的节点名：「A」、「B」 */
function branchTargets(inv: Invocation, node: FlowNode, when: 'pass' | 'fail') {
  return inv.flow.edges
    .filter((e) => e.from === node.id && e.when === when)
    .map((e) => (e.to === END ? '结束' : `「${inv.flow.nodes.find((n) => n.id === e.to)?.title || '未命名节点'}」`))
    .join('、')
}

/** 这次执行的主 Agent 节点：常驻编排器（`@main`），一个对话只有一个，历次运行都用它 */
function openMain(host: EngineHost, inv: Omit<Invocation, 'main'>): MainCtl {
  const id = inv.parentId ? stepPath(inv as Invocation, MAIN_STEP) : MAIN_STEP
  let step = host.task.steps.find((s) => s.id === id)
  if (!step) {
    step = blankStep({
      id,
      parentId: inv.parentId,
      slot: inv.parentId ? inv.slot : '',
      round: inv.round,
      workflowId: inv.workflow.id,
      flowId: inv.flow.id,
      kind: 'main',
      title: inv.parentId ? t('主角色 · {name}', { name: inv.workflow.name }) : t('主角色'),
      agentId: inv.workflow.mainAgentId,
    })
    host.task.steps.push(step)
  }
  // 常驻：不因为一轮调度结束就标成完成，下一条要求回来还是它
  step.status = 'running'
  step.interrupted = false
  if (!step.startedAt) step.startedAt = now()
  step.endedAt = ''
  return { step, workflow: inv.workflow, flow: inv.flow, chain: Promise.resolve(), nested: !!inv.parentId }
}

/** 主 Agent 第一轮（或会话续不上时）的完整提示：共用的开头 + 它的职责和流程概览 */
function mainFull(host: EngineHost, main: MainCtl) {
  const others = host.workflows.filter((w) => w.id !== main.workflow.id && w.id !== DEFAULT_WORKFLOW_ID)
  return [
    ...commonPart(host, main.workflow),
    `${NODE_PART}\n${mainDuties(main.workflow, main.flow, host.agents, others)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 主 Agent 的一轮调度：续接它的会话只交这次的事件（评估、汇总、回答提问），第一轮带上完整提示。
 * 同一个会话不能同时跑两轮，按到达顺序排队
 */
function mainTurn(
  host: EngineHost,
  main: MainCtl,
  kind: NonNullable<AgentCall['dispatching']>,
  event: string,
): Promise<AgentResult> {
  const go = async (): Promise<AgentResult> => {
    if (host.halted && kind !== 'answer') return { ok: false, halted: true, error: '' }
    const mail = takeMail(host, main.step.id)
    const ev = mail.length ? `${event}\n\n## 收到的消息\n${mail.map((m) => `- ${m}`).join('\n')}` : event
    const full = `${mainFull(host, main)}\n\n${ev}`
    const resumed = !!host.task.sessions[main.step.id]
    main.step.rounds++
    host.changed(true)
    return host.runAgent({
      step: main.step,
      agentId: main.step.agentId,
      prompt: resumed ? ev : full,
      fresh: resumed ? full : undefined,
      sessionKey: main.step.id,
      tier: main.workflow.mainTier ?? '',
      dispatching: kind,
      orch: makeOrchestra(host, { workflow: main.workflow, main, tier: main.workflow.mainTier ?? '' }, main.step),
    })
  }
  const p = main.chain.then(go, go)
  main.chain = p.catch(() => undefined)
  return p
}

/** 执行一个带主 Agent 的流程：节点都完成后由主 Agent 整理结果，作为这个流程的输出 */
async function runInvocation(host: EngineHost, inv: Invocation): Promise<FlowResult> {
  const main = inv.main
  const r = await runFlow(host, inv)
  if (!main) return r
  if (!r.ok) {
    if (!r.stopped && !r.halted) {
      main.step.status = 'failed'
      main.step.endedAt = now()
    }
    return r
  }
  // 这一轮已经整理过了（例如主 Agent 自己起停的运行）
  if (main.step.status === 'done') return { ok: true, output: main.step.output }
  const results = topoOrder(inv.flow)
    .map((n) => host.task.steps.find((s) => s.id === stepPath(inv, n.id)))
    .filter((s): s is TaskStep => s?.status === 'done')
    .map((s) => ({ title: s.title, text: s.output }))
  const s = await mainTurn(host, main, 'summary', summaryEvent(results, main.nested))
  if (!s.ok) {
    if (s.stopped || s.halted) return s
    const error = t('主角色整理结果失败：{error}', { error: s.error })
    main.step.status = 'failed'
    main.step.endedAt = now()
    system(host, error, main.step.id, true)
    host.changed(true)
    return { ok: false, error, reported: true }
  }
  const text = stripDispatch(s.text).trim() || r.output
  main.step.output = clip(text, MAX_OUTPUT)
  // 最外层的编排器常驻：这一轮只是把结果整理给用户，不结束它，下一条要求回来还是同一个会话；
  // 嵌套的（委派给另一个工作流）属于那次调用，照常结束
  if (main.nested) {
    main.step.status = 'done'
    main.step.endedAt = now()
  } else main.step.status = 'running'
  host.changed(true)
  return { ok: true, output: main.step.output }
}

// ---- 编排工具：派子 Agent、查状态、提问、传话 ----

/** 同时在跑的派出的子 Agent 最多几个（整个任务），多的排队 */
const MAX_HELPERS_RUNNING = 6
/** 一个节点最多派几个子 Agent */
const MAX_HELPERS_PER_STEP = 12
/** 子 Agent 还能再派子 Agent，最多两层 */
const MAX_HELPER_DEPTH = 2

interface OrchState {
  /** 节点 id → 还没读的消息 */
  mail: Map<string, string[]>
  /** 子 Agent 的节点 id → 执行它的 Promise */
  helpers: Map<string, Promise<void>>
  /** 子 Agent 失败的原因 */
  errors: Map<string, string>
  /** 结果已经交回给派它的节点的子 Agent */
  delivered: Set<string>
  running: number
  queue: (() => void)[]
}
const orchStates = new WeakMap<EngineHost, OrchState>()
function orchState(host: EngineHost): OrchState {
  let st = orchStates.get(host)
  if (!st) {
    st = { mail: new Map(), helpers: new Map(), errors: new Map(), delivered: new Set(), running: 0, queue: [] }
    orchStates.set(host, st)
  }
  return st
}

/** 取走发给这个节点的消息：新架构从运行记录里取，旧任务用内存信箱 */
function takeMail(host: EngineHost, id: string) {
  const st = orchState(host)
  const got = st.mail.get(id) ?? []
  st.mail.delete(id)
  return [...got, ...runMail(host, id)]
}
function putMail(host: EngineHost, id: string, text: string) {
  // 新架构每次运行有自己的记录：写进去，重启后还在，界面上也能看到
  if (sendRunMessage(host, '', id, text)) return
  const st = orchState(host)
  st.mail.set(id, [...(st.mail.get(id) ?? []), text])
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const STATUS_TEXT: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

function helperReport(host: EngineHost, s: TaskStep): HelperReport {
  const st = orchState(host)
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    ...(s.status === 'done' ? { output: s.output } : {}),
    ...(st.errors.get(s.id) ? { error: st.errors.get(s.id) } : {}),
  }
}

/** 节点结束前等它派出的子 Agent 都结束，返回它没取回的结果（并进节点的输出） */
async function settleHelpers(host: EngineHost, step: TaskStep) {
  const st = orchState(host)
  const kids = () => host.task.steps.filter((s) => s.parentId === step.id && s.slot === 'sub')
  await Promise.all(kids().map((k) => st.helpers.get(k.id) ?? Promise.resolve()))
  const late = kids().filter((k) => !st.delivered.has(k.id) && st.helpers.has(k.id))
  for (const k of late) st.delivered.add(k.id)
  return late
    .map((k) =>
      k.status === 'done'
        ? `### ${k.title}\n${k.output || '（没有文字输出）'}`
        : `### ${k.title}\n（${STATUS_TEXT[k.status] ?? k.status}${st.errors.get(k.id) ? `：${clip(st.errors.get(k.id)!, 300)}` : ''}）`,
    )
    .join('\n\n')
}

/** 任务里各个 Agent 的状态，按层级缩进，给 get_status 用 */
function statusTree(host: EngineHost, self: string) {
  const { task } = host
  const name = (id: string) => host.agents.find((a) => a.id === id)?.name ?? ''
  const lines: string[] = []
  const ids = new Set(task.steps.map((s) => s.id))
  // 对话里派的子 Agent 挂在 @chat 下，@chat 自己不是 steps 里的一条：父节点不在的步骤也当作顶层列出来，
  // 否则对话里派出的子 Agent 一个都查不到（get_status 显示「还没有节点」）
  const roots = task.steps.filter((s) => !s.parentId || !ids.has(s.parentId))
  const kidsOf = (pid: string) => task.steps.filter((s) => s.parentId === pid)
  const walk = (list: TaskStep[], depth: number) => {
    // 主 Agent 排在它调度的节点前面
    for (const s of [...list].sort((a, b) => Number(isMainStep(b)) - Number(isMainStep(a)))) {
      if (lines.length >= 80) return
      const label = s.parentId && !isMainStep(s) ? `${SLOT_PROMPT[s.slot] ?? ''} · ${s.title}` : s.title
      const who = name(s.agentId)
      const out = s.status === 'done' && s.output ? `：${clip(s.output.replace(/\s+/g, ' '), 100)}` : ''
      lines.push(
        `${'  '.repeat(depth)}- ${s.id}｜${label}${who ? `（${who}）` : ''}${s.id === self ? '【你】' : ''}：${STATUS_TEXT[s.status] ?? s.status}${out}`,
      )
      walk(kidsOf(s.id), depth + 1)
    }
  }
  walk(roots, 0)
  return lines.join('\n') || '（还没有节点）'
}

/**
 * 编排器通过 run_workflow 工具要求的运行：工具调用不能在里面直接跑整个流程（会和当前这一轮套在一起），
 * 先记下来，等这一轮结束、回到引擎的主循环时再起
 */
const pendingRuns = new WeakMap<EngineHost, string[]>()

function askRun(host: EngineHost, input: string) {
  pendingRuns.set(host, [...(pendingRuns.get(host) ?? []), input])
}

function takePendingRun(host: EngineHost) {
  const list = pendingRuns.get(host)
  if (!list?.length) return ''
  pendingRuns.delete(host)
  return list.join('\n\n')
}

/** 对话 Agent 要求的计划运行：工具调用只记下来，等这一轮 CLI 结束后由引擎同步跑完再继续对话 */
interface PlannedRun {
  workflowId: string
  input: string
}
const pendingPlans = new WeakMap<EngineHost, PlannedRun[]>()

function askPlan(host: EngineHost, plan: PlannedRun) {
  pendingPlans.set(host, [...(pendingPlans.get(host) ?? []), plan])
}

function takePendingPlans(host: EngineHost) {
  const list = pendingPlans.get(host)
  pendingPlans.delete(host)
  return list ?? []
}

/** 编排工具，绑定在调用它的节点上（主 Agent 的调度轮也有一份） */
function makeOrchestra(
  host: EngineHost,
  ctx: {
    workflow?: Workflow
    main?: MainCtl
    tier: NodeTier
    chat?: boolean
    planning?: boolean
    coordinator?: boolean
  },
  self: TaskStep,
): Orchestra {
  const st = orchState(host)
  const { task } = host
  // 能力由 Agent 配置决定：canPlan 才能启动计划，canDelegate 才能分派子对话。
  // 旧的常驻编排器（@main）还能看到，但它们不会出现在新对话里
  const planner = !!ctx.planning || (isMainStep(self) && !self.parentId)
  const coordinator = !!ctx.coordinator
  // 对话的工具调用不属于任何节点：系统消息不挂 step，免得被当成一次运行的节点输出
  const where = self.id === CHAT_STEP ? '' : self.id
  const findStep = (key: string) => {
    const k = key.trim()
    if (/^(main|@main|主 ?Agent)$/i.test(k)) return ctx.main?.step
    return (
      task.steps.find((s) => s.id === k) ??
      task.steps.find((s) => s.title === k && s.status === 'running') ??
      task.steps.find((s) => s.title === k)
    )
  }
  return {
    self: self.id,
    hasMain: !!ctx.main,
    planner,
    common: commonAgents(host.agents)
      .filter((a) => a.id !== self.agentId)
      .map((a) => ({ name: a.name, description: a.description })),
    run(input) {
      if (ctx.chat) return { ok: false, info: '对话里用 start_plan 启动工作流' }
      if (!planner) return { ok: false, info: '只有编排器能起运行，节点里按流程走' }
      const run = currentRun(task)
      if (task.steps.some((s) => !s.parentId && inRun(s.id, run) && s.status === 'running' && !isMainStep(s)))
        return { ok: false, info: '这次运行还有节点在执行，等它走完再起新的运行' }
      askRun(host, input)
      system(host, t('主角色起了新的一次运行：{input}', { input: clip(input || t('按流程图再走一遍'), 300) }), where)
      host.changed(true)
      return { ok: true, info: '这一轮结束后会按流程图跑一次新的运行，节点全部新建' }
    },
    closeRun() {
      if (ctx.chat) return { ok: false, info: '对话里没有进行中的运行可以结束' }
      if (!planner) return { ok: false, info: '只有编排器能结束运行' }
      const run = currentRun(task)
      for (const s of task.steps)
        if (!s.parentId && inRun(s.id, run) && s.status !== 'done' && s.status !== 'skipped') s.status = 'skipped'
      task.flowClosed = true
      return { ok: true, info: '这次运行已经结束，没完成的节点不再执行' }
    },
    planning: !!ctx.planning,
    plan(workflowId, input) {
      if (!ctx.chat) return { ok: false, info: '节点里不能启动计划，按流程执行' }
      if (!ctx.planning)
        return { ok: false, info: '这个 Agent 没有开启「按工作流执行计划」的能力，直接在当前对话里执行' }
      if (task.steps.some((s) => !s.parentId && inRun(s.id, currentRun(task)) && s.status === 'running'))
        return { ok: false, info: '上一次计划还在执行，等它结束再启动新的' }
      askPlan(host, { workflowId: workflowId.trim(), input: input.trim() })
      const wf = workflowId ? task.runs.flatMap((r) => r.workflows).find((w) => w.id === workflowId) : undefined
      const label = wf?.name || workflowId || '默认工作流'
      system(
        host,
        t('开始执行计划（{name}）：{input}', { name: label, input: clip(input || t('按工作流走一遍'), 300) }),
        where,
      )
      host.changed(true)
      return { ok: true, info: '这一轮结束后会同步跑完这次计划，再把结果交回对话' }
    },
    coordinator,
    async conversations() {
      if (!coordinator || !host.listConversations) return '（这个对话不能分派子对话）'
      const list = await host.listConversations()
      if (!list.length) return '（还没有子对话）'
      return list
        .map((c) => `- ${c.id}｜${c.title}｜${c.status}${c.summary ? `：${clip(c.summary, 200)}` : ''}｜最近 ${c.at}`)
        .join('\n')
    },
    async createConversation(title, message, files) {
      if (!coordinator || !host.createConversation) return { ok: false, info: '这个对话不能创建子对话' }
      if (!message.trim()) return { ok: false, info: 'message 不能为空' }
      // 标题由父对话的 Agent 分析需求后给出，不拿用户原话截断凑数
      if (!title.trim())
        return { ok: false, info: 'title 不能为空：先分析这条需求，起一个能区分任务的短标题，再调用一次' }
      const r = await host.createConversation({ title: title.trim(), message, files })
      if (r.ok) {
        system(host, t('新建了子对话「{title}」，这条消息交给它处理', { title: r.title || title }), where)
        host.changed(true)
      }
      return { ok: r.ok, id: r.id, info: r.info }
    },
    async sendToConversation(id, message) {
      if (!coordinator || !host.sendToConversation) return { ok: false, info: '这个对话不能给子对话发消息' }
      if (!message.trim()) return { ok: false, info: 'message 不能为空' }
      const r = await host.sendToConversation(id.trim(), message)
      if (r.ok) host.changed(true)
      return r
    },
    child: !!task.parentTaskId && !!host.messageParent,
    claims: !!host.claimFiles,
    canBackground: !!host.runBackground,
    async runBackground(input) {
      if (!host.runBackground) return { ok: false, info: '这里不能用后台命令，直接执行' }
      if (!input.command.trim()) return { ok: false, info: 'command 是空的' }
      const r = await host.runBackground(input)
      if (r.ok) host.changed(true)
      return r
    },
    checkBackground(id) {
      return host.checkBackground ? host.checkBackground(id.trim()) : '这里没有后台命令'
    },
    canSubmit: !!host.submitBuild,
    async submitBuild(note) {
      if (!host.submitBuild) return { ok: false, info: '你没有独立分支，改动已经在原目录里：直接按项目测试步骤验证' }
      const r = await host.submitBuild(note.trim())
      if (r.ok) {
        system(host, t('已提交编译，等面板合回原目录编译'), where)
        host.changed(true)
      }
      return r
    },
    async toParent(text, question) {
      if (!host.messageParent) return { ok: false, info: '这个对话没有父对话' }
      if (!text.trim()) return { ok: false, info: 'text 不能为空' }
      return host.messageParent(text.trim(), question)
    },
    claim(paths) {
      if (!host.claimFiles) return { ok: false, info: '这个对话不需要认领文件' }
      const list = paths.map((p) => p.trim()).filter(Boolean)
      if (!list.length) return { ok: false, info: 'paths 是空的：写要改的文件或目录（相对项目根）' }
      const r = host.claimFiles(list)
      const lines = [
        r.granted.length ? `已认领：${r.granted.join('、')}` : '',
        r.held.length
          ? `被其他子对话占着（不要改）：${r.held.map((h) => `${h.path}（「${h.by}」）`).join('、')}。先做别的部分，过一会儿再认领；绕不开就用 message_parent 请父对话协调。`
          : '',
      ]
      return { ok: !r.held.length, info: lines.filter(Boolean).join('\n') }
    },
    release(paths) {
      if (!host.releaseFiles) return { ok: false, info: '这个对话不需要认领文件' }
      const n = host.releaseFiles(paths.map((p) => p.trim()).filter(Boolean))
      return { ok: true, info: n ? `已释放 ${n} 条认领` : '没有要释放的认领' }
    },
    readState() {
      const entries = Object.entries(runState(task))
      if (!entries.length) return '（共享状态还是空的）'
      return entries
        .map(([k, v]) => `- ${k}（v${v.version}，${v.by || '未知节点'} 写入，${v.at}）：\n${clip(v.value, 4000)}`)
        .join('\n\n')
    },
    writeState: (key, value) => writeRunState(host, self.id, key, value),
    status: () => statusTree(host, self.id),
    spawn(tasks) {
      const depth = (self.id.match(/\/sub\//g) ?? []).length
      // 子对话本身已经是父对话派出来的一层：里面再派子 Agent 只允许一层，免得一个项目对话开出太多 CLI
      const maxDepth = task.parentTaskId ? 1 : MAX_HELPER_DEPTH
      if (depth >= maxDepth)
        return {
          ids: [],
          error: task.parentTaskId
            ? '子对话里的子 Agent 只能派一层，这一层不能再派了，请自己完成'
            : '子 Agent 最多派两层，这一层不能再派了，请自己完成',
        }
      const list = tasks.filter((x) => x && (x.title?.trim() || x.instructions?.trim()))
      if (!list.length) return { ids: [], error: 'tasks 是空的：每个子任务要写 title 和 instructions' }
      const have = task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub').length
      if (have + list.length > MAX_HELPERS_PER_STEP)
        return { ids: [], error: `一个节点最多派 ${MAX_HELPERS_PER_STEP} 个子 Agent，已经派了 ${have} 个` }
      if (host.halted) return { ids: [], error: '任务已经停止或有节点失败，不再派新的子 Agent' }
      const made = list.map((spec, i) => {
        const want = spec.agent?.trim() ?? ''
        const agent =
          (want && host.agents.find((a) => a.id === want || a.name === want)) ||
          host.agents.find((a) => a.id === self.agentId)
        const n = have + i + 1
        const step = blankStep({
          id: `${self.id}/sub/h${n}`,
          parentId: self.id,
          slot: 'sub',
          workflowId: ctx.workflow?.id ?? '',
          flowId: self.flowId,
          kind: 'agent',
          title: clip((spec.title || spec.instructions).trim().split('\n')[0], 60),
          agentId: agent?.id ?? self.agentId,
        })
        task.steps.push(step)
        const tier = (['high', 'medium', 'low'].includes(spec.tier ?? '') ? spec.tier : ctx.tier) as NodeTier
        return { step, spec, tier }
      })
      for (const m of made)
        st.helpers.set(
          m.step.id,
          runHelper(
            host,
            ctx,
            self,
            m.step,
            m.spec,
            m.tier,
            made.filter((x) => x !== m).map((x) => x.step.title),
          ),
        )
      system(
        host,
        t('「{title}」派出 {n} 个子角色：{list}', {
          title: self.title,
          n: made.length,
          list: made.map((m) => m.step.title).join(t('、')),
        }),
        where,
      )
      host.changed(true)
      return { ids: made.map((m) => m.step.id) }
    },
    async wait(ids, ms) {
      const mine = ids.length
        ? ids
        : task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub').map((s) => s.id)
      const steps = mine.map((id) => task.steps.find((s) => s.id === id)).filter((s): s is TaskStep => !!s)
      await Promise.race([Promise.all(steps.map((s) => st.helpers.get(s.id) ?? Promise.resolve())), sleep(ms)])
      const over = (s: TaskStep) => s.status !== 'running' && (s.status !== 'pending' || !st.helpers.has(s.id))
      const done = steps.filter(over)
      for (const s of done) st.delivered.add(s.id)
      return {
        done: done.map((s) => helperReport(host, s)),
        running: steps.filter((s) => !over(s)).map((s) => helperReport(host, s)),
      }
    },
    async ask(question, ms) {
      const main = ctx.main
      if (!main) return { error: '这个工作流没有主 Agent 调度，自己判断，或者在结果里写明需要用户决定的事' }
      if (main.step.id === self.id) return { error: '你就是主 Agent，自己决定' }
      system(
        host,
        t('「{title}」向主角色提问：{question}', { title: self.title, question: clip(question, 500) }),
        where,
      )
      host.changed(true)
      let settled: AgentResult | undefined
      const p = mainTurn(host, main, 'answer', questionEvent(self.title, question)).then((r) => (settled = r))
      await Promise.race([p, sleep(ms)])
      const text = (r: AgentResult) => (r.ok ? stripDispatch(r.text).trim() : '')
      if (settled) return settled.ok ? { answer: text(settled) } : { error: `主 Agent 没能回答：${settled.error}` }
      // 主 Agent 还在忙（排队或在想）：回答到了放进提问者的收件箱，read_messages 取
      void p.then((r) => {
        if (r.ok) putMail(host, self.id, `主 Agent 回答了你的问题「${clip(question, 80)}」：${text(r)}`)
      })
      return { pending: true }
    },
    async send(to, text) {
      const target = findStep(to)
      if (!target) return { ok: false, info: `找不到「${to}」，用 get_status 看节点 id` }
      if (target.id === self.id) return { ok: false, info: '不能发给自己' }
      if (target.status === 'done' || target.status === 'failed' || target.status === 'skipped')
        return { ok: false, info: `「${target.title}」已经结束了，消息没有送到` }
      const body = `来自「${self.title || '对话'}」的消息：${text.trim()}`
      // 先记进这次运行，界面和重启后都能看到；交给正在跑的节点时再标成已读，避免它重复看到
      const kept = sendRunMessage(host, where, target.id, body)
      system(
        host,
        t('「{from}」→「{to}」：{text}', { from: self.title, to: target.title, text: clip(text, 500) }),
        where,
      )
      host.changed(true)
      if (target.status === 'running' && host.steer && (await host.steer(target.id, body))) {
        const rec = runRecord(task)
        const last = rec?.messages.at(-1)
        if (last && last.to === target.id) last.read = true
        return { ok: true, info: `已交给正在执行的「${target.title}」` }
      }
      if (!kept) putMail(host, target.id, body)
      return {
        ok: true,
        info:
          target.status === 'running'
            ? `已放进「${target.title}」的收件箱，它用 read_messages 能看到`
            : `「${target.title}」还没开始，开始时会带上这条消息`,
      }
    },
    inbox: () => takeMail(host, self.id),
  }
}

/** 执行一个派出的子 Agent */
async function runHelper(
  host: EngineHost,
  ctx: { workflow?: Workflow; main?: MainCtl; tier: NodeTier; chat?: boolean; coordinator?: boolean },
  parent: TaskStep,
  step: TaskStep,
  spec: HelperSpec,
  tier: NodeTier,
  siblings: string[],
) {
  const st = orchState(host)
  if (st.running >= MAX_HELPERS_RUNNING) await new Promise<void>((r) => st.queue.push(r))
  st.running++
  try {
    if (host.halted) return
    step.status = 'running'
    step.startedAt = now()
    host.changed(true)
    const prompt = [
      ...commonPart(host, ctx.workflow),
      `${NODE_PART}\n你是「${isMainStep(parent) ? '主 Agent' : parent.title}」派出的子 Agent，负责其中一部分：${step.title}`,
      spec.instructions.trim() ? `## 要做的事\n${spec.instructions.trim()}` : '',
      siblings.length
        ? `## 同时进行的子 Agent\n下面这些和你同时执行，不要做它们的工作，也尽量不要改同一个文件：\n${siblings.map((x) => `- ${x}`).join('\n')}`
        : '',
      '## 要求\n只完成上面这件事，不要做发起节点的其他工作。完成后用中文简要总结结果，结果会交回给派你的 Agent。',
    ]
      .filter(Boolean)
      .join('\n\n')
    const r = await host.runAgent({
      step,
      agentId: step.agentId,
      prompt,
      sessionKey: step.id,
      tier,
      orch: makeOrchestra(host, { ...ctx, tier }, step),
    })
    if (r.ok) {
      const late = await settleHelpers(host, step)
      step.output = clip(late ? `${r.text}\n\n## 子 Agent 的结果\n${late}` : r.text, MAX_OUTPUT)
      step.status = 'done'
    } else {
      step.status = r.stopped || r.halted ? 'pending' : 'failed'
      if (r.stopped || r.halted) pauseStep(step)
      else {
        st.errors.set(step.id, r.error)
        system(host, r.error || t('执行失败'), step.id, true)
      }
    }
    step.endedAt = now()
    host.changed(true)
  } finally {
    st.running--
    st.queue.shift()?.()
  }
}

/** 按连线执行一个流程，返回连到「结束」的节点的输出 */
async function runFlow(host: EngineHost, inv: Invocation): Promise<FlowResult> {
  const live = reachable(inv.flow)
  const nodes = inv.flow.nodes.filter((n) => live.has(n.id))
  if (!nodes.length) return { ok: true, output: '' }
  const outputs = new Map<string, { title: string; text: string }>()
  /** 条件连线没走到的节点：整段跳过 */
  const skipped = new Set<string>()
  const branch = new Map<string, 'pass' | 'fail'>()
  const started = new Set<string>()
  const running = new Map<string, Promise<void>>()
  const failures: Fail[] = []
  const title = (n: FlowNode) => n.title.trim() || t('节点 {n}', { n: inv.flow.nodes.indexOf(n) + 1 })

  const incoming = (id: string) => inv.flow.edges.filter((e) => e.to === id && (e.from === START || live.has(e.from)))
  /** 这条线走得通：上游完成了，条件（如果有）和上游的结论一致 */
  const taken = (e: FlowEdge) =>
    e.from === START || (outputs.has(e.from) && (!e.when || e.when === (branch.get(e.from) ?? 'pass')))
  const settled = (e: FlowEdge) => e.from === START || outputs.has(e.from) || skipped.has(e.from)

  const ready = () => nodes.filter((n) => !started.has(n.id) && incoming(n.id).every(settled))

  for (;;) {
    let progressed = true
    while (progressed && !failures.length && !host.halted) {
      progressed = false
      for (const n of ready()) {
        started.add(n.id)
        const ins = incoming(n.id)
        // 进来的线一条都没走通（上游走了另一条分支，或者上游被跳过）：这个节点也跳过
        if (ins.length && !ins.some(taken)) {
          skipped.add(n.id)
          const step = ensureStep(host, inv, n, inv.flow.nodes.indexOf(n))
          if (step.status !== 'done') step.status = 'skipped'
          progressed = true
          continue
        }
        // 只把走通的线上的上游结果交给它
        const upstream = new Map(
          ins.filter(taken).flatMap((e) => (outputs.has(e.from) ? [[e.from, outputs.get(e.from)!]] : [])),
        )
        running.set(
          n.id,
          runNode(host, inv, n, inv.flow.nodes.indexOf(n), upstream).then((r) => {
            running.delete(n.id)
            if (r.ok) {
              const step = host.task.steps.find((s) => s.id === stepPath(inv, n.id))
              if (step?.branch) branch.set(n.id, step.branch)
              outputs.set(n.id, { title: title(n), text: r.output })
            } else {
              failures.push(r)
              host.halted = true
            }
          }),
        )
      }
    }
    if (!running.size) break
    await Promise.race(running.values())
  }

  if (failures.length) {
    const stopped = failures.find((f) => f.stopped)
    const real = failures.filter((f) => !f.halted && !f.stopped)
    if (stopped) return stopped
    if (!real.length) return failures[0]
    return real.length === 1
      ? real[0]
      : { ok: false, error: real.map((f) => f.error).join('\n\n'), reported: real.every((f) => f.reported) }
  }
  // 别处失败后这里没跑完：不能当成功返回
  if (host.halted && nodes.some((n) => !outputs.has(n.id) && !skipped.has(n.id)))
    return { ok: false, halted: true, error: '' }
  const ends = inv.flow.edges.filter((e) => e.to === END && outputs.has(e.from) && taken(e)).map((e) => e.from)
  const sinks = ends.length
    ? ends
    : nodes
        .filter((n) => outputs.has(n.id) && !inv.flow.edges.some((e) => e.from === n.id && live.has(e.to)))
        .map((n) => n.id)
  const out = sinks.map((id) => outputs.get(id)!).filter(Boolean)
  return {
    ok: true,
    output: out.length === 1 ? out[0].text : out.map((o) => `### ${o.title}\n${o.text}`).join('\n\n'),
  }
}

/** 对话 Agent 的伪节点：只用来绑定编排工具，不进入 task.steps */
const CHAT_STEP = '@chat'
function chatStep(host: EngineHost, agentId: string): TaskStep {
  return {
    ...blankStep({ id: CHAT_STEP, title: t('对话'), agentId }),
    status: 'running',
    startedAt: now(),
  }
}

/** 对话里启动一次工作流运行：节点全部新建，同步跑完，结果交回对话 */
async function startPlan(host: EngineHost, plan: PlannedRun): Promise<{ ok: boolean; text: string; error?: string }> {
  const snap = host.resolveWorkflow?.(plan.workflowId)
  const workflow =
    snap?.workflow ?? (plan.workflowId ? host.workflows.find((w) => w.id === plan.workflowId) : host.workflow)
  if (!workflow)
    return {
      ok: false,
      text: '',
      error: t('找不到要执行的工作流：{id}', { id: plan.workflowId || t('默认工作流') }),
    }
  const workflows = snap?.workflows ?? workflowClosure(workflow, host.workflows)
  const skillSlots = snap?.skillSlots ?? host.task.skillSlots
  // runSeq 是已经跑完的次数：第一次计划是第 1 次运行
  const run = (host.task.runSeq ?? 0) + 1
  host.task.runSeq = run
  host.task.flowClosed = false
  host.workflow = workflow
  host.workflows = workflows
  host.task.workflowId = workflow.id
  host.task.workflowName = workflow.name
  host.task.workflows = workflows
  host.task.skillSlots = skillSlots
  ensureTaskRun(host, workflow, run, skillSlots)
  for (const s of planTask(workflow, run).steps)
    if (!host.task.steps.some((x) => x.id === s.id)) host.task.steps.push(s)
  host.changed(true)
  const inv: Invocation = {
    workflow,
    flow: entryFlow(workflow),
    parentId: '',
    slot: '',
    round: 0,
    input: plan.input || host.prompt,
    depth: 0,
    run,
  }
  const r = await runFlow(host, inv)
  const rec = host.task.runs.find((x) => x.id === run)
  if (rec) {
    rec.status = r.ok ? 'done' : r.stopped ? 'stopped' : 'failed'
    rec.endedAt = now()
  }
  // 一次运行失败不拖住后面的对话：下一次计划重新开始
  host.halted = false
  host.changed(true)
  return r.ok ? { ok: true, text: r.output } : { ok: false, text: '', error: r.error }
}

/** 对话 Agent 的提示：这次的消息、可选工作流、子对话目录，以及分派规则 */
async function conversationPrompt(host: EngineHost, kind: 'top' | 'sub', planning: boolean, coordinator: boolean) {
  const catalog = host.workflowCatalog?.() ?? []
  const wt = host.task.worktree?.state === 'active' ? host.task.worktree : null
  const parts = [
    `## 用户这次的消息\n${host.prompt}`,
    policyPart(host),
    goalPart(host),
    rulesPart(host),
    inboxPart(host),
    buildPart(host),
    backgroundPart(host),
    statePart(host.task),
    // 独立分支的子对话：不说清楚它会以为自己在项目目录里，去切分支或把改动提交到错的地方
    wt
      ? `## 执行目录
你在独立分支 ${wt.branch} 的单独目录里工作，不是项目目录；项目目录里的未提交改动看不到。
${
  host.task.parentTaskId
    ? '别的子对话改不到这里，你也不用认领文件，放心改。编译不在这里跑，改完用 submit_build 交给面板合回原目录编译，见下面的「编译交给面板」。'
    : '提交留在这个分支上，由用户决定合并还是丢弃。'
}不要自己切换 / 检出新分支、不要推送到远端、不要合并主分支。
${wt.baseBranch ? `这个分支从「${wt.baseBranch}」开出。` : ''}`
      : '',
    catalog.length && planning
      ? `## 可用工作流\n${catalog
          .map(
            (w, i) =>
              `- id: ${w.id}｜${w.name}${i === 0 ? '（默认）' : ''}：${w.description}${w.steps.length ? `（节点：${w.steps.join(' → ')}）` : ''}`,
          )
          .join('\n')}\n\n需要按计划执行时调用 start_plan，workflow 写上面的 id；不写就是默认工作流。`
      : planning
        ? '## 可用工作流\n项目还没有配置工作流，直接在对话里执行。'
        : '## 工作流\n当前 Agent 没有开启「按工作流执行计划」的能力，直接在对话里执行。',
  ]
  if (coordinator) {
    const list = host.listConversations ? await host.listConversations() : []
    parts.push(
      `## 现有子对话\n${
        list.length
          ? list
              .map((c) => `- ${c.id}｜${c.title}｜${c.status}：${clip(c.summary, 200) || '（还没有结果）'}`)
              .join('\n')
          : '（还没有子对话）'
      }`,
      `## 这条消息怎么处理
1. 先判断它和现有子对话的关联强度：相关就调用 send_to_conversation，把消息交给最合适的那个子对话。
2. 现有子对话都不相关，而且需要修改代码或者做较大的研究：调用 create_conversation 新建一个子对话，标题由你分析后起，message 写完整的需求和背景；子对话会按项目的默认工作流列计划并执行。
3. 只是一般问题、讨论或很小的请求（改一两行、改个文案）：自己当场处理，比新建子对话快得多。
一条消息里有几件互不相关的事时拆开，分别交给不同的子对话，它们会同时执行。不要把同一件事发给多个子对话。子对话不能再创建子对话，子对话之间也不能直接通讯，需要配合时由你转达。
分派时把你已经查到的东西一起交过去：相关文件和行号、已经确认的结论、用户的原话和验收标准都写进 message，子对话不用从头再摸一遍。

${
  host.childIsolation === 'worktree'
    ? `## 子对话各自在独立分支里改
要改代码的子对话都有自己的独立分支目录，只用来隔离改文件，互相看不到对方改到一半的文件。
- 编译不在子对话里跑：子对话改完调用 submit_build，面板排队把它合回原目录（这个对话所在的目录）试编译，通过才提交，失败撤回并把报错推回给那个子对话。一次只合一个，相当于构建锁。
- 每次合并编译的结果会告诉你。子对话反复失败、或者报错其实是别的子对话的改动引起的，由你协调。
- 几个子对话都合进去之后，需要的话派「测试验收」在原目录里跑一遍完整的测试。`
    : `## 子对话共用一个目录
所有子对话都在同一个目录里直接改，不建独立分支。为了不互相覆盖：
- 新建子对话时用 files 写清它负责的文件或目录（相对项目根），面板替它认领；别的子对话改这些文件要等它做完。
- 两件事会改同一批文件时，交给同一个子对话，或者等前一个做完再交给下一个。
- 编译、全量测试会读到别的子对话改到一半的文件：同一时间只让一个子对话跑编译，结果不对时先确认是不是别人的改动造成的。
- 子对话报告文件冲突或者提问时，由你决定谁先做、怎么分，再用 send_to_conversation 告诉它们。`
}`,
    )
  } else if (kind === 'top') {
    parts.push(`## 执行方式\n直接在对话里回答或执行当前任务；没有创建子对话的能力。`)
  } else {
    parts.push(
      planning
        ? `## 执行方式
你只负责当前这个子对话的任务。要修改代码、跨模块改动或较大的研究时，调用 start_plan 按项目的默认工作流执行（更合适的可选工作流写它的 id）；只是问题、分析或一两行的小改动直接在对话里做。你没有创建子对话的能力。`
        : `## 执行方式
你只负责当前这个子对话的任务，直接在对话里执行。你没有创建子对话或按工作流启动计划的能力。`,
    )
    if (host.messageParent)
      parts.push(
        host.claimFiles
          ? `## 和父对话、其他子对话的协作
你是项目对话分出来的子对话，和其他子对话在同一个目录里同时工作（没有独立分支）：
- 改文件前先用 claim_files 认领要改的文件或目录；被别的子对话占着的不要改，先做别的部分或用 message_parent 请父对话协调。做完一部分可以用 release_files 释放。
- 不要切换分支、不要 reset / checkout 别人的文件、不要格式化整个仓库，只动自己负责的范围。
- 编译或测试报错的位置不在你改的文件里时，先确认是不是别的子对话正在改的，不要去修别人的文件；提交时只 git add 你自己改的文件，不用 -A。
- 需要决定、发现和别的任务有关、或者做完一个阶段时，用 message_parent 告诉父对话（question 设为 true 表示需要它决定）。你不能直接联系其他子对话。`
          : `## 和父对话的协作
你是项目对话分出来的子对话。只动自己负责的范围，不要格式化整个仓库。
需要决定、发现和别的任务有关、或者做完一个阶段时，用 message_parent 告诉父对话（question 设为 true 表示需要它决定）。你不能直接联系其他子对话。`,
      )
  }
  return parts.filter(Boolean).join('\n\n')
}

/** 一轮对话：调用对话 Agent；它启动的计划在这一轮里同步跑完，再交回结果继续对话 */
async function runConversationTurn(host: EngineHost, who: string) {
  const { task } = host
  const kind = task.parentTaskId ? 'sub' : 'top'
  // 能不能分派子对话由 Agent 自己的能力开关决定；子对话本身永远不能再分派
  const agent = who ? host.agents.find((a) => a.id === who) : undefined
  const coordinator = kind === 'top' && !!agent?.canDelegate
  const planning = !!agent?.canPlan
  const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, who)
  if (turn) host.changed(true)
  try {
    let prompt = await conversationPrompt(host, kind, planning, coordinator)
    for (let i = 0; i < 4; i++) {
      const r = await host.runAgent({
        agentId: who,
        prompt,
        // 会话键就是 Agent id；选了「无」时用空字符串，runner 仍然按对话处理
        sessionKey: who,
        ...(host.prewarm ? { prewarm: true } : {}),
        orch: makeOrchestra(
          host,
          { workflow: host.workflow, tier: '', chat: true, planning, coordinator },
          chatStep(host, who),
        ),
      })
      if (!r.ok) {
        if (turn) endTurn(task, turn, r.stopped ? 'stopped' : 'failed')
        if (host.prewarm) {
          task.status = r.stopped ? 'stopped' : (host.prewarmFrom ?? 'done')
          return
        }
        return finish(host, r)
      }
      const plans = takePendingPlans(host)
      if (!plans.length) break
      const results: string[] = []
      for (const p of plans) {
        const out = await startPlan(host, p)
        results.push(
          out.ok
            ? `### 计划执行完成\n${clip(out.text || '（没有文字输出）', 12000)}`
            : `### 计划执行失败\n${clip(out.error || '执行失败', 4000)}`,
        )
      }
      prompt = `## 计划执行结果\n${results.join('\n\n')}\n\n请根据结果继续：向用户说明完成了什么、有哪些改动和遗留问题；需要再启动一次计划就继续调用 start_plan。`
    }
    if (turn) endTurn(task, turn, 'done')
    if (host.task.parentTaskId) host.task.summary = summaryOf(host.task)
    // 预热没有处理新消息时由调用方恢复状态
    if (host.prewarm && (task.turnDoneAt ?? '') === host.prewarmTurnDoneAt) return
    task.status = 'done'
    host.changed(true)
  } catch (e) {
    if (turn) endTurn(task, turn, 'failed')
    throw e
  }
}

/** 子对话的摘要：最近一条 Agent 回复的开头，父对话的协调 Agent 用它判断关联 */
function summaryOf(task: Task) {
  const last = [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())
  return last ? clip(last.text.replace(/\s+/g, ' ').trim(), 300) : ''
}

function followUpPrompt(host: EngineHost, blocked?: TaskStep) {
  const { original } = userRequests(host.task)
  if (host.task.mode === 'chat') return host.prompt
  return [
    `用户对任务「${host.task.title}」提出了追加要求：\n${host.prompt}`,
    `## 任务的原始需求\n${original}`,
    host.workflow?.document.trim() ? `## 工作流说明\n${host.workflow.document.trim()}` : '',
    blocked
      ? `工作流停在了节点「${blocked.title}」：它的结论是不通过，后面的节点还没有执行。它的结果：\n${clip(blocked.output, 3000)}\n\n` +
        `请按追加要求处理（例如修好不通过的地方），必要时自己验证；完成后用中文简要说明改了什么。之后会重新执行「${blocked.title}」，通过后接着走后面的流程，后面节点的工作不用你做。`
      : host.task.flowClosed
        ? '用户已经结束了工作流，没完成的节点不再执行。请按追加要求直接修改，必要时自己验证；完成后用中文简要说明改了什么。'
        : '工作流的各个节点已经完成。请按追加要求直接修改，必要时自己验证；完成后用中文简要说明改了什么。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function finish(host: EngineHost, r: Fail) {
  for (const s of host.task.steps)
    if (s.status === 'running') {
      s.status = r.stopped ? 'pending' : 'failed'
      s.interrupted = !!r.stopped
      if (r.stopped) pauseStep(s)
      s.endedAt = now()
    }
  if (r.budget) system(host, r.error, '', false, true)
  else if (r.stopped)
    system(
      host,
      host.task.mode === 'workflow'
        ? t('已暂停。点「继续流程」从中断的地方接着做，或者在下面输入新的要求。')
        : t('已暂停。点「继续执行」从中断的地方接着做，或者在下面输入新的要求。'),
      '',
      false,
      true,
    )
  else {
    const failed = host.task.steps
      .filter((s) => s.status === 'failed' && !s.parentId)
      .map((s) => t('「{title}」', { title: s.title }))
    system(
      host,
      r.reported
        ? t('{nodes}执行失败，原因见节点里的错误。可以点「继续流程」重试，或者在下面输入新的要求。', {
            nodes: failed.join(t('、')) || t('有节点'),
          })
        : r.error || t('执行失败'),
      '',
      true,
      true,
    )
  }
  host.task.status = r.stopped ? 'stopped' : 'failed'
  host.changed(true)
}

/**
 * 执行一轮：
 * - 对话模式直接发给对应 Agent
 * - 工作流模式由常驻编排器（`@main`）负责：这次运行还没走完就按流程图接着执行；
 *   走完了就把用户的新要求交给它，由它决定起一次新的运行、重跑，还是直接回答
 */
export async function runEngineTurn(host: EngineHost) {
  const { task } = host
  task.status = 'running'
  // 预算按每次执行算：从这一轮开始时的用量起算
  task.budgetFrom = { usd: task.usage.costUsd, tokens: task.usage.inputTokens + task.usage.outputTokens }
  // 旧版对话里的常驻编排器不再工作：记录留着可以看，但不再参与执行
  for (const s of task.steps) if (isMainStep(s) && s.status !== 'done' && s.status !== 'skipped') s.status = 'skipped'
  host.changed(true)

  // 新架构里项目对话都是对话：Agent 自己决定直接执行，还是用 start_plan 启动工作流
  if (task.mode === 'chat') return runConversationTurn(host, task.agentId)

  const wf = host.workflow
  const run = currentRun(task)
  const flow = taskFlow(task, wf)
  let tops = topSteps(task)
  if (task.mode === 'workflow' && flow && !task.flowClosed) {
    // 任务开始后工作流改过：已经不在流程图里的节点不会再执行，标成跳过，免得这次运行永远「没跑完」
    const live = reachable(flow)
    for (const s of tops) if (s.status !== 'done' && !live.has(s.nodeId)) s.status = 'skipped'
    if (!tops.length && !live.size)
      return finish(host, {
        ok: false,
        error: t('工作流的主流程还没有连到「开始」的节点，请先在流程图里从「开始」连线'),
      })
  }
  const dispatching = !!wf && !!flow && dispatches(wf, flow)
  // 流程停在某个节点的结论上（例如前置检查不通过）：继续流程时从它重新检查；追加要求先交给主 Agent 处理，再接着走
  const blocked = task.mode === 'workflow' ? blockedStep(task, flow) : undefined
  if (blocked && host.resume) reopenFlow(task, blocked)
  const unfinished =
    task.mode === 'workflow' &&
    !task.flowClosed &&
    (tops.length === 0 || tops.some((s) => s.status !== 'done' && s.status !== 'skipped'))

  /** 按流程图执行第 n 次运行（没完成的节点接着做）；input 是编排器为这次运行补充的要求 */
  const runWorkflow = async (n: number, input = ''): Promise<boolean> => {
    // 旧版工作流任务没有运行记录：这里补一条，节点共享状态和消息按运行保存
    const rec = wf ? ensureTaskRun(host, wf, n) : undefined
    if (rec) {
      rec.status = 'running'
      rec.endedAt = ''
    }
    const inv: Invocation = {
      workflow: wf!,
      flow: flow!,
      parentId: '',
      slot: '',
      round: 0,
      input,
      depth: 0,
      run: n,
    }
    if (dispatching) inv.main = openMain(host, inv)
    const r = await runInvocation(host, inv)
    if (rec) {
      rec.status = r.ok ? 'done' : r.stopped ? 'stopped' : 'failed'
      rec.endedAt = now()
    }
    if (!r.ok) {
      finish(host, r)
      return false
    }
    const stuck = blockedStep(task, flow)
    if (stuck)
      system(
        host,
        t(
          '流程停在「{title}」：结论是不通过，后面的节点没有执行。可以输入要求让主角色处理，处理完会自动接着走流程；也可以点「继续流程」重新检查。',
          { title: stuck.title },
        ),
        '',
        false,
        true,
      )
    return true
  }

  /** 起一次新的运行：节点全部新建（只复用编排器的会话），按流程图执行 */
  const newRun = async (input: string): Promise<boolean> => {
    const n = run + 1
    task.runSeq = n
    task.flowClosed = false
    // 新一次运行的节点：编排器还是原来那个，其余全部新建
    const fresh = planTask(wf, n).steps.filter((s) => !isMainStep(s))
    for (const s of fresh) if (!task.steps.some((x) => x.id === s.id)) task.steps.push(s)
    if (input) system(host, t('主角色起了第 {n} 次运行：{input}', { n, input: clip(input, 300) }), '')
    tops = topSteps(task)
    host.changed(true)
    return runWorkflow(n)
  }

  // 新对话的第一条要求先交给常驻编排器分析，由它决定要不要起运行；没有编排器的单节点工作流照旧直接执行。
  // 新建任务时节点已经按流程排好（都是待执行），第一次运行还没开始
  const first =
    task.mode === 'workflow' &&
    !!wf &&
    !!flow &&
    dispatching &&
    !task.flowClosed &&
    run === 1 &&
    tops.every((s) => s.status === 'pending')

  if (first) {
    const inv: Invocation = { workflow: wf!, flow: flow!, parentId: '', slot: '', round: 0, input: '', depth: 0, run }
    // 前面已经直接回答过几条时，这次不是这个对话的第一条要求
    const replanned = (mainStep(task)?.rounds ?? 0) > 0
    const main = openMain(host, inv)
    const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, main.step.agentId)
    if (turn) host.changed(true)
    const r = await mainTurn(host, main, 'plan', firstPlanEvent(host.prompt, !replanned))
    if (turn) endTurn(task, turn, r.ok ? 'done' : r.stopped ? 'stopped' : 'failed')
    if (!r.ok) {
      if (host.prewarm) {
        task.status = r.stopped ? 'stopped' : (host.prewarmFrom ?? 'done')
        return
      }
      return finish(host, r)
    }
    const d = parseDispatch(r.text) ?? { action: 'answer' as const }
    main.step.output = clip(stripDispatch(r.text).trim(), MAX_OUTPUT)
    host.changed(true)
    // 编排器用工具直接要求的运行（run_workflow）优先，其次才是 dispatch 里的决定
    const asked = takePendingRun(host)
    const input = asked || (d.action === 'run' ? (d.input ?? '') : d.action === 'restart' ? d.feedback : '')
    if (asked || d.action === 'run' || d.action === 'restart') {
      if (input) system(host, t('主角色起了第 {n} 次运行：{input}', { n: run, input: clip(input, 300) }), main.step.id)
      if (!(await runWorkflow(run, input))) return
    } else {
      system(host, dispatchText(d, t('第一条要求')), main.step.id)
      host.changed(true)
    }
  } else if (task.mode === 'workflow' && wf && flow && unfinished) {
    if (!(await runWorkflow(run))) return
  } else if (task.mode === 'workflow' && unfinished) {
    return finish(host, { ok: false, error: t('工作流不存在，可能已被删除') })
  } else if (task.mode === 'workflow' && wf && flow && dispatching) {
    // 这次运行已经走完：新要求交给常驻编排器，由它决定起新运行、重跑还是直接回答
    const inv: Invocation = { workflow: wf, flow, parentId: '', slot: '', round: 0, input: '', depth: 0, run }
    const main = openMain(host, inv)
    const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, main.step.agentId)
    if (turn) host.changed(true)
    const r = await mainTurn(host, main, 'plan', planEvent(host.prompt, run, blocked ?? undefined))
    if (turn) endTurn(task, turn, r.ok ? 'done' : r.stopped ? 'stopped' : 'failed')
    if (!r.ok) {
      if (host.prewarm) {
        task.status = r.stopped ? 'stopped' : (host.prewarmFrom ?? 'done')
        return
      }
      return finish(host, r)
    }
    const d = parseDispatch(r.text) ?? { action: 'answer' as const }
    main.step.output = clip(stripDispatch(r.text).trim(), MAX_OUTPUT)
    system(host, dispatchText(d, t('这次要求')), main.step.id)
    host.changed(true)
    // 编排器用工具直接要求的运行（run_workflow）优先，其次才是 dispatch 里的决定
    const asked = takePendingRun(host)
    if (asked) {
      if (!(await newRun(asked))) return
    } else if (d.action === 'run' || d.action === 'restart') {
      if (!(await newRun(d.action === 'run' ? (d.input ?? '') : d.feedback))) return
    }
  } else {
    const who = host.workflow?.mainAgentId ?? topSteps(task)[0]?.agentId ?? ''
    // 追加要求（工作流关掉了调度时）：续接主 Agent 最近执行过的节点
    if (task.mode === 'workflow' && !task.sessions[who]) {
      const last = [...task.steps].reverse().find((s) => s.agentId === who && task.sessions[s.id])
      if (last) task.sessions[who] = task.sessions[last.id]
    }
    if (!who) return finish(host, { ok: false, error: t('没有可以回答的角色，请先给工作流选择主角色') })
    // 每一轮单独记耗时和用量，任务进度里能看到工作流跑完后的追加要求；预热不算一轮
    const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, who)
    if (turn) host.changed(true)
    const r = await host.runAgent({
      agentId: who,
      prompt: followUpPrompt(host, blocked),
      sessionKey: who,
      // 工作流任务的追加要求也走默认 CLI 的档位，和节点一致
      ...(task.mode === 'workflow' ? { tier: '' as NodeTier } : {}),
      ...(host.prewarm ? { prewarm: true } : {}),
    })
    if (turn) endTurn(task, turn, r.ok ? 'done' : r.stopped ? 'stopped' : 'failed')
    // 预热失败（CLI 没装好、会话续不上等）不算这一轮：回到原来的状态，等用户发消息时再按正常流程报错
    if (!r.ok) {
      if (host.prewarm) {
        task.status = r.stopped ? 'stopped' : (host.prewarmFrom ?? 'done')
        // 列表时间留给收尾恢复，不要因为预热失败改成现在
        return
      }
      return finish(host, r)
    }
    // 处理完停住流程的问题：从停住的节点重新检查，接着走后面的流程
    if (blocked && wf && flow && blockedStep(task, flow) === blocked) {
      reopenFlow(task, blocked)
      system(host, t('处理完了，从「{title}」重新检查，接着走流程', { title: blocked.title }))
      host.changed(true)
      if (!(await runWorkflow(run))) return
    }
  }
  // 预热没有处理新消息：不标完成、不刷新列表时间，交给 start 收尾恢复
  if (host.prewarm && (task.turnDoneAt ?? '') === host.prewarmTurnDoneAt) return
  // 编排器这一轮忙完了：标成完成只表示它空闲，会话还在，下一条要求接着用同一个会话
  const idle = mainStep(task)
  if (idle?.status === 'running') {
    idle.status = 'done'
    idle.endedAt = now()
  }
  task.status = 'done'
  host.changed(true)
}
