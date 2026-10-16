/**
 * 执行引擎：按流程图调度节点，真实执行和模拟执行共用。
 *
 * - 从「开始」出发，一个节点的上游全部完成后才执行，没有依赖关系的节点同时执行
 * - 节点可以挂三个流程入口：开始（结果作为初始资料）、验收（不通过就把意见交回节点继续完善）、
 *   结束（结果并入节点输出）；也可以整个节点就是执行另一个流程
 * - 每个节点在 task.steps 里有一条记录，id 是路径（`n1/review.2/n5`），也用作 CLI 会话键；
 *   续跑时已完成的节点直接复用输出
 *
 * 怎么调用一个 Agent 由宿主决定（server/exec/runner.ts 调用 CLI，shared/runner.ts 生成示例输出）。
 */
import {
  END,
  START,
  type Agent,
  type Flow,
  type FlowNode,
  type FlowEdge,
  type FlowRef,
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
  topSteps,
} from './flow.ts'
import { t } from './i18n.ts'

/** 提示词里的流程入口名，固定用中文（提示词不跟随界面语言） */
const SLOT_PROMPT: Record<string, string> = { start: '开始', review: '验收', end: '结束', body: '执行' }

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
}

export interface EngineHost {
  task: Task
  agents: Agent[]
  /** 所有工作流（节点可以引用其他工作流） */
  workflows: Workflow[]
  workflow?: Workflow
  /** 本轮的用户输入 */
  prompt: string
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

export function system(host: EngineHost, text: string, step = '', error = false) {
  host.task.messages.push({
    id: host.newId(),
    role: 'system',
    agentId: '',
    step,
    text,
    tools: [],
    ...(error && { error }),
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
  const users = task.messages.filter((m) => m.role === 'user' && !m.step).map((m) => m.text)
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
        return /^(review|end)(\.\d+)?$/.test(seg) || /^body\.\d+$/.test(seg)
      })
      .map((s) => s.id),
  )
  if (!drop.size) return
  host.task.steps = host.task.steps.filter((s) => !drop.has(s.id))
  host.task.messages = host.task.messages.filter((m) => !drop.has(m.step))
}

function nodePrompt(host: EngineHost, inv: Invocation, node: FlowNode, step: TaskStep, input: string, start: string) {
  const { original, extra } = userRequests(host.task)
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
  return [
    `你正在执行工作流「${inv.workflow.name}」里流程「${flowLabel(inv.flow, inv.workflow)}」的节点：${step.title}`,
    inv.owner
      ? `这个流程是节点「${inv.owner}」的${SLOT_PROMPT[inv.slot]}流程${reviewing ? `（第 ${inv.round} 轮验收）` : ''}。`
      : '',
    `## 用户需求\n${original}`,
    extra.length ? `## 用户的补充要求\n${extra.map((t) => `- ${t}`).join('\n')}` : '',
    inv.workflow.document.trim() ? `## 工作流说明\n${inv.workflow.document.trim()}` : '',
    node.instructions.trim() ? `## 本节点要做的事\n${node.instructions.trim()}` : '',
    start ? `## 开始流程的结果（作为本节点的初始资料）\n${start}` : '',
    input ? `## 输入\n${input}` : '',
    siblings.length
      ? `## 同时进行的节点\n下面这些节点可能和你同时执行，不要做它们的工作，也尽量不要改同一个文件：\n${siblings
          .map((s) => `- ${s.title || '未命名节点'}（${name(nodeAgent(inv.workflow, s.agentId))}）`)
          .join('\n')}`
      : '',
    `## 要求\n只完成本节点「${step.title}」，不要做其他节点的工作。完成后用中文简要总结：做了什么、改了哪些文件、有没有遗留问题。`,
    reviewing
      ? '你在验收上面「输入」里的结果。逐条检查，不通过时列出必须修改的地方。最后单独一行写「验收结论：通过」或「验收结论：不通过」。'
      : '',
    branches.length && !reviewing
      ? `## 结论\n后面的流程按你的结论走${route('pass') ? `：通过时接着做${route('pass')}` : ''}${route('fail') ? `；不通过时接着做${route('fail')}` : ''}。完成后最后单独一行写「结论：通过」或「结论：不通过」。`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
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
  if (!resumeHalf) dropRerun(host, step)
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
  const input = [
    ups.includes(START) && inv.input ? inv.input : '',
    upstream.length ? `上游节点的结果：\n\n${upstream.join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const sub = (ref: FlowRef | null, slot: TaskStep['slot'], round: number, subInput: string) =>
    runRef(host, inv, ref, { parentId: step.id, slot, round, input: subInput, owner: step.title })

  const fail = (r: Fail): FlowResult => {
    step.status = r.stopped || r.halted ? 'pending' : 'failed'
    // 被停止时已经做了一部分，记下来，继续执行时续接会话
    step.interrupted = !!r.stopped && !!host.task.sessions[step.id]
    if (r.stopped || r.halted) step.startedAt = ''
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

  // 后面有条件连线：要求节点给出结论，按结论选路
  const deciding = node.kind === 'agent' && inv.flow.edges.some((e) => e.from === node.id && e.when)

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
    const full = nodePrompt(host, inv, node, step, input, start)
    const cont =
      round === 0 && resumeHalf
        ? `上次执行到一半被中断了（停止或面板重启）。请检查已经做了哪些，从中断的地方接着完成本节点「${step.title}」的工作，完成后同样简要总结。`
        : ''
    const tail = deciding && (extra || cont) ? '\n\n最后同样单独一行写「结论：通过」或「结论：不通过」。' : ''
    return host.runAgent({
      step,
      agentId: step.agentId,
      prompt: (extra || cont || full) + tail,
      fresh: extra || cont ? `${full}\n\n${extra}` : undefined,
      sessionKey: step.id,
      reviewing: inv.slot === 'review',
      deciding,
    })
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
  return runFlow(host, { ...o, workflow: target.workflow, flow: target.flow, depth: from.depth + 1 })
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

function followUpPrompt(host: EngineHost) {
  const { original } = userRequests(host.task)
  if (host.task.mode === 'chat') return host.prompt
  return [
    `用户对任务「${host.task.title}」提出了追加要求：\n${host.prompt}`,
    `## 任务的原始需求\n${original}`,
    host.workflow?.document.trim() ? `## 工作流说明\n${host.workflow.document.trim()}` : '',
    '工作流的各个节点已经完成。请按追加要求直接修改，必要时自己验证；完成后用中文简要说明改了什么。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function finish(host: EngineHost, r: Fail) {
  for (const s of host.task.steps)
    if (s.status === 'running') {
      s.status = r.stopped ? 'pending' : 'failed'
      s.interrupted = !!r.stopped
      s.endedAt = now()
    }
  if (r.budget) system(host, r.error)
  else if (r.stopped) system(host, t('已暂停。点「继续执行」从中断的地方接着做，或者在下面输入新的要求。'))
  else {
    const failed = host.task.steps
      .filter((s) => s.status === 'failed' && !s.parentId)
      .map((s) => t('「{title}」', { title: s.title }))
    system(
      host,
      r.reported
        ? t('{nodes}执行失败，原因见节点里的错误。可以点「继续执行」重试，或者在下面输入新的要求。', {
            nodes: failed.join(t('、')) || t('有节点'),
          })
        : r.error || t('执行失败'),
      '',
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
  const flow = wf && (wf.flows.find((f) => f.id === (task.steps[0]?.flowId || wf.entryFlowId)) ?? wf.flows[0])
  const tops = topSteps(task)
  if (task.mode === 'workflow' && flow) {
    // 任务开始后工作流改过：已经不在流程图里的节点不会再执行，标成跳过，免得任务永远「没跑完」
    const live = reachable(flow)
    for (const s of tops) if (s.status !== 'done' && !live.has(s.nodeId)) s.status = 'skipped'
    if (!tops.length && !live.size)
      return finish(host, {
        ok: false,
        error: t('工作流的主流程还没有连到「开始」的节点，请先在流程图里从「开始」连线'),
      })
  }
  const unfinished = !tops.length || tops.some((s) => s.status !== 'done' && s.status !== 'skipped')
  if (task.mode === 'workflow' && wf && flow && unfinished) {
    const r = await runFlow(host, { workflow: wf, flow, parentId: '', slot: '', round: 0, input: '', depth: 0 })
    if (!r.ok) return finish(host, r)
  } else if (task.mode === 'workflow' && unfinished) {
    return finish(host, { ok: false, error: t('工作流不存在，可能已被删除') })
  } else {
    const who = task.mode === 'chat' ? task.agentId : (host.workflow?.mainAgentId ?? topSteps(task)[0]?.agentId ?? '')
    // 追加要求：续接主 Agent 最近执行过的节点的会话，带上它之前的上下文
    if (task.mode === 'workflow' && !task.sessions[who]) {
      const last = [...task.steps].reverse().find((s) => s.agentId === who && task.sessions[s.id])
      if (last) task.sessions[who] = task.sessions[last.id]
    }
    if (!who) return finish(host, { ok: false, error: t('没有可以回答的 Agent，请先给工作流选择主 Agent') })
    const r = await host.runAgent({ agentId: who, prompt: followUpPrompt(host), sessionKey: who })
    if (!r.ok) return finish(host, r)
  }
  task.status = 'done'
  host.changed(true)
}
