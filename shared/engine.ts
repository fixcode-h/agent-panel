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
  type NodeTier,
  type ParamValues,
  type Task,
  type TaskStep,
  type Workflow,
} from './schema.ts'
import {
  blankStep,
  flowLabel,
  nodeAgent,
  parallelTo,
  preds,
  reachable,
  resolveRef,
  stepTree,
  topoOrder,
  topSteps,
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
  mainDuties,
  parseDispatch,
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
  /** 主 Agent 的调度轮：评估节点、整理最终结果、回答子 Agent 的提问（模拟执行据此给出示例输出） */
  dispatching?: 'evaluate' | 'summary' | 'answer'
  /** 工作流里的调用都带编排工具：派子 Agent、查状态、提问、传话（真实执行交给 CLI 的 MCP） */
  orch?: Orchestra
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
  /** 可以直接派的通用 Agent（名字和简介），spawn_agents 里列出来 */
  common: { name: string; description: string }[]
  status(): string
  spawn(tasks: HelperSpec[]): { ids: string[]; error?: string }
  wait(ids: string[], ms: number): Promise<{ done: HelperReport[]; running: HelperReport[] }>
  ask(question: string, ms: number): Promise<{ answer?: string; pending?: boolean; error?: string }>
  send(to: string, text: string): Promise<{ ok: boolean; info: string }>
  inbox(): string[]
}

export interface EngineHost {
  task: Task
  agents: Agent[]
  /** 所有工作流（节点可以引用其他工作流） */
  workflows: Workflow[]
  workflow?: Workflow
  /** 本轮的用户输入 */
  prompt: string
  /** 这一轮是「继续流程」，不是新的要求：停在某个节点结论上的流程从那个节点重新检查后接着走 */
  resume?: boolean
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
}

const MAX_DEPTH = 6
const MAX_OUTPUT = 4000
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const now = () => new Date().toISOString()

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
  inv.parentId ? `${inv.parentId}/${inv.slot}${inv.round ? `.${inv.round}` : ''}/${nodeId}` : nodeId

function ensureStep(host: EngineHost, inv: Invocation, node: FlowNode, index: number): TaskStep {
  const id = stepPath(inv, node.id)
  let step = host.task.steps.find((s) => s.id === id)
  if (!step) {
    step = blankStep({
      id,
      parentId: inv.parentId,
      slot: inv.parentId ? inv.slot : '',
      round: inv.round,
      workflowId: inv.workflow.id,
      flowId: inv.flow.id,
      nodeId: node.id,
      kind: node.kind,
      title: node.title.trim() || t('节点 {n}', { n: index + 1 }),
      agentId: node.kind === 'agent' ? nodeAgent(inv.workflow, node.agentId) : '',
    })
    host.task.steps.push(step)
  }
  return step
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
 * 同一个任务里各个节点（包括主 Agent、派出的子 Agent）都一样的开头：需求、工作流说明、通用要求。
 * 放在最前面，按前缀匹配缓存的模型服务（Codex 等）能多命中一段
 */
function commonPart(host: EngineHost, w: Workflow) {
  const { original, extra } = userRequests(host.task)
  return [
    `## 用户需求\n${original}`,
    extra.length ? `## 用户的补充要求\n${extra.map((t) => `- ${t}`).join('\n')}` : '',
    w.document.trim() ? `## 工作流说明\n${w.document.trim()}` : '',
    '## 通用要求\n完成后用中文简要总结：做了什么、改了哪些文件、有没有遗留问题。\n' +
      // 一次输出太长时，模型服务的连接容易中途断开，整个节点白做
      '写很长的文件时分几次写：先写开头一部分，再分段追加或编辑补上，每次不超过约 300 行；不要一次输出整个大文件。',
  ]
}

function nodePrompt(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  step: TaskStep,
  input: string,
  start: string,
  deciding: boolean,
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
    `${NODE_PART}\n你正在执行工作流「${inv.workflow.name}」里流程「${flowLabel(inv.flow, inv.workflow)}」的节点：${step.title}` +
      (inv.owner
        ? `\n这个流程是节点「${inv.owner}」的${SLOT_PROMPT[inv.slot]}流程${reviewing ? `（第 ${inv.round} 轮验收）` : ''}。`
        : ''),
    node.instructions.trim() ? `## 本节点要做的事\n${node.instructions.trim()}` : '',
    start ? `## 开始流程的结果（作为本节点的初始资料）\n${start}` : '',
    input ? `## 输入\n${input}` : '',
    siblings.length
      ? `## 同时进行的节点\n下面这些节点可能和你同时执行，不要做它们的工作，也尽量不要改同一个文件：\n${siblings
          .map((s) => `- ${s.title || '未命名节点'}（${name(nodeAgent(inv.workflow, s.agentId))}）`)
          .join('\n')}`
      : '',
    `## 要求\n只完成本节点「${step.title}」，不要做其他节点的工作。`,
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
function prevRoundSession(host: EngineHost, inv: Invocation, node: FlowNode) {
  if (!inv.parentId || node.kind !== 'agent') return ''
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
  return host.task.sessions[stepPath({ ...inv, round: prev }, node.id)] ?? ''
}

/** 续接上一轮会话时的提示：只交这一轮的输入，其余要求上一轮已经给过 */
function nextRoundPrompt(inv: Invocation, step: TaskStep, input: string) {
  const what =
    inv.slot === 'review'
      ? `这是第 ${inv.round} 轮验收：被验收的节点按上一轮的意见修改过了，下面是修改后的结果。请在上一轮检查的基础上重新逐条验收，确认上一轮提出的问题都已解决、没有引入新的问题。最后单独一行写「验收结论：通过」或「验收结论：不通过」。`
      : `上一轮的结果需要修改，下面是这一轮的输入。请在你上一轮工作的基础上继续完善本节点「${step.title}」，完成后同样简要总结。`
  return [what, input ? `## 输入\n${input}` : ''].filter(Boolean).join('\n\n')
}

/** 执行一个节点（含开始、验收、结束入口） */
async function runNode(
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
      return { ok: false, error: t('「{title}」没有可执行的 Agent，请先给工作流选择主 Agent', { title: step.title }) }
    const full = nodePrompt(host, inv, node, step, input, start, deciding && inv.slot !== 'review')
    // 验收的第 2 轮起、流程节点返工的子节点：续接上一轮同一个节点的会话，只交这一轮的新输入。
    // 上一轮读过的代码、给过的意见都在会话里，整段历史能命中缓存；不续接的话每轮都从头读一遍
    const prev = round === 0 && !resumeHalf && !host.task.sessions[step.id] ? prevRoundSession(host, inv, node) : ''
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
            : { ...ev, error: t('主 Agent 评估「{title}」失败：{error}', { title: step.title, error: ev.error }) },
        )
      let d: Dispatch | null = parseDispatch(ev.text)
      if (!d) {
        system(host, t('主 Agent 没有写调度决定，「{title}」按通过处理。', { title: step.title }), step.id)
        d = { action: 'continue' }
      }
      // 退回次数用完、委派来回太多次：只能继续或停下
      if (d.action === 'rework' && reworks >= node.hooks.maxRounds)
        return fail({
          ok: false,
          error: t('主 Agent 退回「{title}」{n} 次后仍不满意：{feedback}', {
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
      if (branchy) step.branch = d.branch ?? 'pass'
      if (d.note) text = `${text}\n\n主 Agent 的交代：${d.note}`
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
  const inv: Invocation = { ...o, workflow: target.workflow, flow: target.flow, depth: from.depth + 1, main: from.main }
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

/** 条件连线通向的节点名：「A」、「B」 */
function branchTargets(inv: Invocation, node: FlowNode, when: 'pass' | 'fail') {
  return inv.flow.edges
    .filter((e) => e.from === node.id && e.when === when)
    .map((e) => (e.to === END ? '结束' : `「${inv.flow.nodes.find((n) => n.id === e.to)?.title || '未命名节点'}」`))
    .join('、')
}

/** 这次执行的主 Agent 节点：最外层是 @main，嵌套的挂在发起的节点下（`n2/body/@main`） */
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
      title: inv.parentId ? t('主 Agent · {name}', { name: inv.workflow.name }) : t('主 Agent'),
      agentId: inv.workflow.mainAgentId,
    })
    host.task.steps.push(step)
  }
  if (step.status !== 'done') {
    step.status = 'running'
    step.interrupted = false
    if (!step.startedAt) step.startedAt = now()
    step.endedAt = ''
  }
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
  if (main.step.status === 'done') return { ok: true, output: main.step.output }
  const results = topoOrder(inv.flow)
    .map((n) => host.task.steps.find((s) => s.id === stepPath(inv, n.id)))
    .filter((s): s is TaskStep => s?.status === 'done')
    .map((s) => ({ title: s.title, text: s.output }))
  const s = await mainTurn(host, main, 'summary', summaryEvent(results, main.nested))
  if (!s.ok) {
    if (s.stopped || s.halted) return s
    const error = t('主 Agent 整理结果失败：{error}', { error: s.error })
    main.step.status = 'failed'
    main.step.endedAt = now()
    system(host, error, main.step.id, true)
    host.changed(true)
    return { ok: false, error, reported: true }
  }
  const text = stripDispatch(s.text).trim() || r.output
  main.step.output = clip(text, MAX_OUTPUT)
  main.step.status = 'done'
  main.step.endedAt = now()
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

/** 取走发给这个节点的消息 */
function takeMail(host: EngineHost, id: string) {
  const st = orchState(host)
  const got = st.mail.get(id) ?? []
  st.mail.delete(id)
  return got
}
function putMail(host: EngineHost, id: string, text: string) {
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
  const walk = (pid: string, depth: number) => {
    const kids = task.steps.filter((s) => s.parentId === pid)
    // 主 Agent 排在它调度的节点前面
    kids.sort((a, b) => Number(isMainStep(b)) - Number(isMainStep(a)))
    for (const s of kids) {
      if (lines.length >= 80) return
      const label = s.parentId && !isMainStep(s) ? `${SLOT_PROMPT[s.slot] ?? ''} · ${s.title}` : s.title
      const who = name(s.agentId)
      const out = s.status === 'done' && s.output ? `：${clip(s.output.replace(/\s+/g, ' '), 100)}` : ''
      lines.push(
        `${'  '.repeat(depth)}- ${s.id}｜${label}${who ? `（${who}）` : ''}${s.id === self ? '【你】' : ''}：${STATUS_TEXT[s.status] ?? s.status}${out}`,
      )
      walk(s.id, depth + 1)
    }
  }
  walk('', 0)
  return lines.join('\n') || '（还没有节点）'
}

/** 编排工具，绑定在调用它的节点上（主 Agent 的调度轮也有一份） */
function makeOrchestra(
  host: EngineHost,
  ctx: { workflow: Workflow; main?: MainCtl; tier: NodeTier },
  self: TaskStep,
): Orchestra {
  const st = orchState(host)
  const { task } = host
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
    common: commonAgents(host.agents)
      .filter((a) => a.id !== self.agentId)
      .map((a) => ({ name: a.name, description: a.description })),
    status: () => statusTree(host, self.id),
    spawn(tasks) {
      const depth = (self.id.match(/\/sub\//g) ?? []).length
      if (depth >= MAX_HELPER_DEPTH) return { ids: [], error: '子 Agent 最多派两层，这一层不能再派了，请自己完成' }
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
          workflowId: ctx.workflow.id,
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
        t('「{title}」派出 {n} 个子 Agent：{list}', {
          title: self.title,
          n: made.length,
          list: made.map((m) => m.step.title).join(t('、')),
        }),
        self.id,
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
        t('「{title}」向主 Agent 提问：{question}', { title: self.title, question: clip(question, 500) }),
        self.id,
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
      const body = `来自「${isMainStep(self) ? '主 Agent' : self.title}」的消息：${text.trim()}`
      system(
        host,
        t('「{from}」→「{to}」：{text}', { from: self.title, to: target.title, text: clip(text, 500) }),
        self.id,
      )
      host.changed(true)
      // 子 Agent 之间传话也让主 Agent 知道，调度时心里有数
      if (ctx.main && !isMainStep(self) && target.id !== ctx.main.step.id)
        putMail(host, ctx.main.step.id, `「${self.title}」给「${target.title}」发了消息：${clip(text, 300)}`)
      if (target.status === 'running' && host.steer && (await host.steer(target.id, body)))
        return { ok: true, info: `已交给正在执行的「${target.title}」` }
      if (target.status === 'done' || target.status === 'failed' || target.status === 'skipped')
        return { ok: false, info: `「${target.title}」已经结束了，消息没有送到` }
      putMail(host, target.id, body)
      return {
        ok: true,
        info: isMainStep(target)
          ? '已交给主 Agent，它下一次调度时会看到'
          : target.status === 'running'
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
  ctx: { workflow: Workflow; main?: MainCtl; tier: NodeTier },
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

/** 执行一轮：工作流还没跑完时按流程图执行；跑完后由主 Agent 处理追加要求；对话模式直接发给对应 Agent */
export async function runEngineTurn(host: EngineHost) {
  const { task } = host
  task.status = 'running'
  // 预算按每次执行算：从这一轮开始时的用量起算
  task.budgetFrom = { usd: task.usage.costUsd, tokens: task.usage.inputTokens + task.usage.outputTokens }
  host.changed(true)

  const wf = host.workflow
  const flow = taskFlow(task, wf)
  const tops = topSteps(task)
  if (task.mode === 'workflow' && flow && !task.flowClosed) {
    // 任务开始后工作流改过：已经不在流程图里的节点不会再执行，标成跳过，免得任务永远「没跑完」
    const live = reachable(flow)
    for (const s of tops) if (s.status !== 'done' && !live.has(s.nodeId)) s.status = 'skipped'
    if (!tops.length && !live.size)
      return finish(host, {
        ok: false,
        error: t('工作流的主流程还没有连到「开始」的节点，请先在流程图里从「开始」连线'),
      })
  }
  // 主 Agent 也算没跑完：节点都完成了、最后的整理还没做（或者被打断）
  const top = mainStep(task)
  const dispatching = !!wf && !!flow && dispatches(wf, flow)
  // 任务开始后关掉了调度：主 Agent 不再参与
  if (top && !dispatching && top.status !== 'done') top.status = 'skipped'
  // 流程停在某个节点的结论上（例如前置检查不通过）：继续流程时从它重新检查；追加要求先交给主 Agent 处理，再接着走
  const blocked = task.mode === 'workflow' ? blockedStep(task, flow) : undefined
  if (blocked && host.resume) reopenFlow(task, blocked)
  const unfinished =
    !task.flowClosed &&
    (!tops.length ||
      tops.some((s) => s.status !== 'done' && s.status !== 'skipped') ||
      (dispatching && !!top && top.status !== 'done' && top.status !== 'skipped'))
  /** 按流程图执行（没完成的节点接着做） */
  const runWorkflow = async (): Promise<boolean> => {
    const inv: Invocation = { workflow: wf!, flow: flow!, parentId: '', slot: '', round: 0, input: '', depth: 0 }
    if (dispatching) inv.main = openMain(host, inv)
    const r = await runInvocation(host, inv)
    if (!r.ok) {
      finish(host, r)
      return false
    }
    const stuck = blockedStep(task, flow)
    if (stuck)
      system(
        host,
        t(
          '流程停在「{title}」：结论是不通过，后面的节点没有执行。可以输入要求让主 Agent 处理，处理完会自动接着走流程；也可以点「继续流程」重新检查。',
          { title: stuck.title },
        ),
        '',
        false,
        true,
      )
    return true
  }
  if (task.mode === 'workflow' && wf && flow && unfinished) {
    if (!(await runWorkflow())) return
  } else if (task.mode === 'workflow' && unfinished) {
    return finish(host, { ok: false, error: t('工作流不存在，可能已被删除') })
  } else {
    const who = task.mode === 'chat' ? task.agentId : (host.workflow?.mainAgentId ?? topSteps(task)[0]?.agentId ?? '')
    // 追加要求：续接主 Agent 的会话（它调度过整个流程，最了解全局）；没有调度时续接主 Agent 最近执行过的节点
    if (task.mode === 'workflow' && !task.sessions[who] && top && task.sessions[top.id])
      task.sessions[who] = task.sessions[top.id]
    if (task.mode === 'workflow' && !task.sessions[who]) {
      const last = [...task.steps].reverse().find((s) => s.agentId === who && task.sessions[s.id])
      if (last) task.sessions[who] = task.sessions[last.id]
    }
    if (!who) return finish(host, { ok: false, error: t('没有可以回答的 Agent，请先给工作流选择主 Agent') })
    // 每一轮单独记耗时和用量，任务进度里能看到工作流跑完后的追加要求
    const turn = beginTurn(task, host.newId(), host.prompt, who)
    host.changed(true)
    const r = await host.runAgent({
      agentId: who,
      prompt: followUpPrompt(host, blocked),
      sessionKey: who,
      // 工作流任务的追加要求也走默认 CLI 的档位，和节点一致
      ...(task.mode === 'workflow' ? { tier: '' as NodeTier } : {}),
    })
    endTurn(task, turn, r.ok ? 'done' : r.stopped ? 'stopped' : 'failed')
    if (!r.ok) return finish(host, r)
    // 处理完停住流程的问题：从停住的节点重新检查，接着走后面的流程
    if (blocked && wf && flow && blockedStep(task, flow) === blocked) {
      reopenFlow(task, blocked)
      system(host, t('处理完了，从「{title}」重新检查，接着走流程', { title: blocked.title }))
      host.changed(true)
      if (!(await runWorkflow())) return
    }
  }
  task.status = 'done'
  host.changed(true)
}
