/**
 * 工作流的流程图：节点和连线组成的有向图。从「开始」出发，一个节点的上游全部完成后才执行它，
 * 没有依赖关系的节点同时执行。这里放前后端共用的图逻辑：遍历、布局、模板、引用解析、任务规划。
 */
import {
  END,
  START,
  stagesToFlow,
  type Agent,
  type Flow,
  type FlowNode,
  type FlowRef,
  type NodeStep,
  type TaskStep,
  type Workflow,
  type WorkflowInput,
  type WorkflowMember,
} from './schema.ts'
import { t } from './i18n.ts'

const rand = () => Math.random().toString(36).slice(2, 10)
export const flowId = (prefix: 'nd' | 'e' | 'fl' | 'st') => `${prefix}_${rand()}`
export { START, END }

export const COL = 300
export const ROW = 150

export function newFlow(name: string, id = flowId('fl')): Flow {
  return { id, name, description: '', nodes: [], edges: [], startPos: { x: 0, y: 0 }, endPos: { x: 600, y: 0 } }
}

export function newNode(o: Partial<FlowNode> & { x: number; y: number }): FlowNode {
  return {
    id: flowId('nd'),
    title: '',
    kind: 'agent',
    agentId: '',
    flow: null,
    instructions: '',
    steps: [],
    tier: '',
    params: {},
    retries: 0,
    hooks: { start: null, review: null, end: null, maxRounds: 3 },
    ...o,
  }
}

/** 新的一步：稳定 id 用 st_xxx */
export function newNodeStep(o: Partial<NodeStep> = {}): NodeStep {
  return {
    id: flowId('st'),
    title: '',
    kind: 'agent',
    agentId: '',
    flow: null,
    tier: '',
    params: {},
    instructions: '',
    retries: 0,
    review: null,
    maxRounds: 3,
    ...o,
  }
}

/**
 * 节点实际执行的步骤：有显式 steps 就用它；旧的单执行者节点合成一步，
 * id 用节点 id，执行记录和会话键都和以前一致
 */
export function nodeSteps(n: FlowNode): NodeStep[] {
  if (n.steps.length) return n.steps
  return [
    {
      id: n.id,
      title: '',
      kind: n.kind,
      agentId: n.agentId,
      flow: n.flow,
      tier: n.tier,
      params: n.params,
      instructions: n.instructions,
      retries: n.retries,
      confirm: n.hooks.confirm,
      review: n.hooks.review,
      maxRounds: n.hooks.maxRounds,
    },
  ]
}

/** 步骤 id 不能占用的路径段：执行记录的 id 是路径，这些会和多记录的结构冲突 */
export const RESERVED_STEP_IDS = ['start', 'review', 'end', 'body', 'step', 'sub', 'call']

export const getFlow = (w: Pick<WorkflowInput, 'flows'>, id: string) => w.flows.find((f) => f.id === id)
/** 主流程：任务从这里开始 */
export const entryFlow = (w: Pick<WorkflowInput, 'flows' | 'entryFlowId'>) => getFlow(w, w.entryFlowId) ?? w.flows[0]
export const flowLabel = (f: Flow, w: Pick<WorkflowInput, 'entryFlowId'>) =>
  f.name.trim() || (f.id === w.entryFlowId ? t('主流程') : t('未命名子流程'))

export const preds = (f: Flow, id: string) => f.edges.filter((e) => e.to === id).map((e) => e.from)
export const succs = (f: Flow, id: string) => f.edges.filter((e) => e.from === id).map((e) => e.to)

/** 从开始出发能走到的节点 */
export function reachable(f: Flow): Set<string> {
  const seen = new Set<string>()
  const stack = [START]
  while (stack.length) {
    const cur = stack.pop()!
    for (const n of succs(f, cur)) if (n !== END && !seen.has(n)) (seen.add(n), stack.push(n))
  }
  return seen
}

/** 加一条 from → to 的线会不会形成环 */
export function wouldCycle(f: Flow, from: string, to: string) {
  if (from === to) return true
  const stack = [to]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === from) return true
    for (const n of succs(f, cur)) if (!seen.has(n)) (seen.add(n), stack.push(n))
  }
  return false
}

/** 能执行的节点按拓扑顺序排列（同层按位置从左到右、从上到下） */
export function topoOrder(f: Flow): FlowNode[] {
  const live = reachable(f)
  const nodes = f.nodes.filter((n) => live.has(n.id))
  const indeg = new Map(nodes.map((n) => [n.id, preds(f, n.id).filter((p) => live.has(p)).length]))
  const out: FlowNode[] = []
  let layer = nodes.filter((n) => indeg.get(n.id) === 0)
  while (layer.length) {
    layer.sort((a, b) => a.x - b.x || a.y - b.y)
    out.push(...layer)
    const next: FlowNode[] = []
    for (const n of layer)
      for (const s of succs(f, n.id)) {
        if (!indeg.has(s)) continue
        indeg.set(s, indeg.get(s)! - 1)
        if (indeg.get(s) === 0) next.push(nodes.find((x) => x.id === s)!)
      }
    layer = next
  }
  return out
}

/** 祖先节点（不含开始） */
function ancestors(f: Flow, id: string) {
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length)
    for (const p of preds(f, stack.pop()!)) if (p !== START && !seen.has(p)) (seen.add(p), stack.push(p))
  return seen
}

/** 和这个节点没有先后关系、可能同时执行的节点 */
export function parallelTo(f: Flow, id: string): FlowNode[] {
  const live = reachable(f)
  const up = ancestors(f, id)
  return f.nodes.filter((n) => n.id !== id && live.has(n.id) && !up.has(n.id) && !ancestors(f, n.id).has(id))
}

/** 节点所在的层（从开始算的最长路径），用于自动排列 */
function depths(f: Flow) {
  const d = new Map<string, number>()
  for (const n of topoOrder(f)) {
    const ps = preds(f, n.id).filter((p) => p !== START && d.has(p))
    d.set(n.id, ps.length ? Math.max(...ps.map((p) => d.get(p)! + 1)) : 0)
  }
  return d
}

/** 自动排列：按层从左到右，同层从上到下；没连上的节点放在最下面一排 */
export function autoLayout(f: Flow): Flow {
  const d = depths(f)
  const cols = new Map<number, FlowNode[]>()
  for (const n of topoOrder(f)) cols.set(d.get(n.id)!, [...(cols.get(d.get(n.id)!) ?? []), n])
  const pos = new Map<string, { x: number; y: number }>()
  for (const [c, ns] of cols)
    ns.forEach((n, i) => pos.set(n.id, { x: 260 + c * COL, y: (i - (ns.length - 1) / 2) * ROW }))
  const tallest = Math.max(1, ...[...cols.values()].map((c) => c.length))
  const loose = f.nodes.filter((n) => !pos.has(n.id))
  loose.forEach((n, i) => pos.set(n.id, { x: 260 + i * COL, y: ((tallest + 1) / 2) * ROW + 40 }))
  return {
    ...f,
    nodes: f.nodes.map((n) => ({ ...n, ...pos.get(n.id)! })),
    startPos: { x: 0, y: 0 },
    endPos: { x: 260 + Math.max(cols.size, 1) * COL, y: 0 },
  }
}

export const edge = (from: string, to: string) => ({ id: flowId('e'), from, to })

/** 按团队生成一个默认流程：主 Agent 分析 → 子 Agent 同时实现 → 主 Agent 验收 */
export function flowTemplate(members: { agent: Agent; responsibility: string }[], base: Flow): Flow {
  const n = (title: string, agentId: string, instructions: string) =>
    newNode({ title, agentId, instructions, x: 0, y: 0 })
  const plan = n(t('分析需求、拆分任务'), '', '阅读需求和相关代码，列出要改动的部分、每个节点的分工和验收标准。')
  const work = members.length
    ? members.map((m) =>
        n(
          (m.responsibility || m.agent.description || m.agent.name).slice(0, 60),
          m.agent.id,
          '按分析阶段的分工完成自己负责的部分，只改自己负责的文件，完成后说明改了什么。',
        ),
      )
    : [n(t('实现'), '', '按分析阶段的结论完成改动，并自测。')]
  const check = n(t('验收'), '', '逐条对照验收标准检查结果，列出没满足的地方。')
  return autoLayout({
    ...base,
    nodes: [plan, ...work, check],
    edges: [
      edge(START, plan.id),
      ...work.flatMap((w) => [edge(plan.id, w.id), edge(w.id, check.id)]),
      edge(check.id, END),
    ],
  })
}

/** 节点的执行 Agent：没指定时是主 Agent */
export const nodeAgent = (w: Pick<Workflow, 'mainAgentId'>, agentId: string) => agentId || w.mainAgentId

/** 工作流用到的子 Agent：节点上选的（子 Agent 现在在节点上配），加上旧版团队里列过的；不含主 Agent */
export function subAgentIds(w: Pick<Workflow, 'mainAgentId' | 'members' | 'flows'>) {
  return [
    ...new Set([
      ...w.flows.flatMap((f) => f.nodes.flatMap((n) => nodeSteps(n).map((s) => s.agentId))),
      ...(w.members ?? []).map((m) => m.agentId),
    ]),
  ].filter((id) => id && id !== w.mainAgentId)
}

/** 主 Agent 在任务节点里的 id（流程节点、委派里的主 Agent 是 `<父节点>/<入口>/@main`） */
export const MAIN_STEP = '@main'
export const isMainStep = (s: { kind: string }) => s.kind === 'main'

/**
 * 同一个对话里工作流可以按顺序跑多次，每次是一个「运行」，节点互相隔离。
 * 第 1 次运行的节点沿用原来的 id（旧任务也按第 1 次算），之后的加 `r2/`、`r3/` 前缀。
 */
export const runPrefix = (run: number) => (run > 1 ? `r${run}/` : '')

/** 这个 id 是不是属于第 run 次运行 */
export const inRun = (id: string, run: number) => (run > 1 ? id.startsWith(runPrefix(run)) : !/^r\d+\//.test(id))

/** 任务现在跑到第几次运行（还没开始时算第 1 次） */
export const currentRun = (task: { runSeq?: number }) => Math.max(1, task.runSeq ?? 0)

/**
 * 这个流程执行时要不要主 Agent 调度：工作流打开了调度、选了主 Agent，并且流程里有事可调度
 * （有子 Agent 的节点、调用流程的节点，或者不止一个节点）。只有一个主 Agent 自己做的节点时不需要，
 * 免得「默认」这类单节点工作流多花两轮
 */
export function dispatches(w: Pick<Workflow, 'dispatch' | 'mainAgentId'>, f: Flow) {
  if (w.dispatch === false || !w.mainAgentId) return false
  const live = reachable(f)
  const nodes = f.nodes.filter((n) => live.has(n.id))
  return (
    nodes.length > 1 ||
    nodes.some((n) => nodeSteps(n).some((s) => s.kind === 'flow' || nodeAgent(w, s.agentId) !== w.mainAgentId))
  )
}

/** 引用的流程：同工作流的子流程，或另一个工作流的主流程 */
export function resolveRef(
  ref: FlowRef | null,
  w: Workflow,
  workflows: Workflow[],
): { workflow: Workflow; flow: Flow } | null {
  if (!ref) return null
  if (ref.kind === 'sub') {
    const flow = getFlow(w, ref.id)
    return flow ? { workflow: w, flow } : null
  }
  const other = workflows.find((x) => x.id === ref.id)
  return other ? { workflow: other, flow: entryFlow(other) } : null
}

export function refLabel(
  ref: FlowRef | null,
  w: Pick<WorkflowInput, 'flows' | 'entryFlowId'>,
  workflows: Pick<Workflow, 'id' | 'name'>[],
) {
  if (!ref) return ''
  if (ref.kind === 'sub') {
    const f = getFlow(w, ref.id)
    return f ? flowLabel(f, w) : t('（流程已删除）')
  }
  return workflows.find((x) => x.id === ref.id)?.name ?? t('（工作流已删除）')
}

/** 一个流程直接引用的流程 */
export function refsOf(f: Flow): FlowRef[] {
  return f.nodes
    .flatMap((n) => [
      ...[n.kind === 'flow' ? n.flow : null, n.hooks.start, n.hooks.review, n.hooks.end],
      ...nodeSteps(n).flatMap((s) => [s.kind === 'flow' ? s.flow : null, s.review]),
    ])
    .filter((r): r is FlowRef => !!r)
}

/** 找出循环引用（A 的节点调用 B，B 又调用 A），返回环上的流程名 */
export function findRefCycle(w: Workflow, workflows: Workflow[]): string[] | null {
  const all = [w, ...workflows.filter((x) => x.id !== w.id)]
  const key = (wf: Workflow, f: Flow) => `${wf.id}:${f.id}`
  const name = (wf: Workflow, f: Flow) => (wf.id === w.id ? flowLabel(f, wf) : `${wf.name} · ${flowLabel(f, wf)}`)
  const visit = (wf: Workflow, f: Flow, path: { k: string; n: string }[]): string[] | null => {
    const k = key(wf, f)
    const at = path.findIndex((p) => p.k === k)
    if (at >= 0) return [...path.slice(at).map((p) => p.n), name(wf, f)]
    if (path.length > 12) return null
    for (const r of refsOf(f)) {
      const t = resolveRef(r, wf, all)
      if (!t) continue
      const c = visit(t.workflow, t.flow, [...path, { k, n: name(wf, f) }])
      if (c) return c
    }
    return null
  }
  for (const f of w.flows) {
    const c = visit(w, f, [])
    if (c) return c
  }
  return null
}

export function blankStep(o: Partial<TaskStep> & Pick<TaskStep, 'id' | 'title'>): TaskStep {
  return {
    parentId: '',
    slot: '',
    round: 0,
    workflowId: '',
    flowId: '',
    nodeId: '',
    kind: 'agent',
    agentId: '',
    status: 'pending',
    startedAt: '',
    endedAt: '',
    spentMs: 0,
    waitMs: 0,
    waitStartedAt: '',
    output: '',
    verdict: '',
    rounds: 0,
    interrupted: false,
    command: [],
    changes: [],
    runId: 1,
    ...o,
  }
}

/**
 * 把工作流的主流程展开成任务节点（子流程在执行时才展开）。
 * 主 Agent 是常驻编排器：只在第 1 次运行时建一个，一直活到对话结束，负责起停每一次运行；
 * 第 2 次起只建流程节点，节点 id 加 `r{n}/` 前缀和上一次运行隔离。
 */
export function planTask(workflow: Workflow | undefined, run = 1): { steps: TaskStep[] } {
  if (!workflow) return { steps: [] }
  const flow = entryFlow(workflow)
  const p = runPrefix(run)
  const main =
    run === 1 && dispatches(workflow, flow)
      ? [
          blankStep({
            id: MAIN_STEP,
            workflowId: workflow.id,
            flowId: flow.id,
            kind: 'main',
            title: t('主 Agent'),
            agentId: workflow.mainAgentId,
          }),
        ]
      : []
  return {
    steps: [
      ...main,
      ...topoOrder(flow).map((n, i) => {
        const first = nodeSteps(n)[0]
        return blankStep({
          id: `${p}${n.id}`,
          workflowId: workflow.id,
          flowId: flow.id,
          nodeId: n.id,
          kind: first.kind,
          title: n.title.trim() || t('节点 {n}', { n: i + 1 }),
          agentId: first.kind === 'agent' ? nodeAgent(workflow, first.agentId) : '',
          runId: run,
        })
      }),
    ],
  }
}

/** 第 run 次运行的主流程节点（不含子节点和常驻编排器） */
export const topSteps = (task: { steps: TaskStep[] }, run = currentRun(task as { runSeq?: number })) =>
  task.steps.filter((s) => !s.parentId && !isMainStep(s) && inRun(s.id, run))
/**
 * 常驻编排器：一个对话只有一个（`@main`），历次运行都用它，所以不带运行前缀；
 * 委派给其他工作流时的主 Agent 挂在发起的节点下面，不在这里找
 */
export const mainStep = (task: { steps: TaskStep[] }) => task.steps.find((s) => s.id === MAIN_STEP)

type FlowTask = { mode: string; steps: TaskStep[]; flowClosed?: boolean; runSeq?: number }

/** 任务这次运行走的主流程：这次运行的节点记下的流程，还没有节点时是入口流程 */
export function taskFlow(task: { steps: TaskStep[]; runSeq?: number }, w: Workflow | undefined): Flow | undefined {
  const mine = topSteps(task)
  return w && (w.flows.find((f) => f.id === (mine[0]?.flowId || w.entryFlowId)) ?? w.flows[0])
}

/**
 * 流程停在了哪个节点：它的结论（例如前置检查「不通过」）没有能走的连线，后面的节点都被跳过，流程没走到结束。
 * 用户结束了流程时不算
 */
export function blockedStep(task: FlowTask, flow: Flow | undefined): TaskStep | undefined {
  if (task.mode !== 'workflow' || task.flowClosed || !flow) return undefined
  return topSteps(task).find((s) => {
    if (s.status !== 'done' || !s.branch || s.flowId !== flow.id) return false
    const out = flow.edges.filter((e) => e.from === s.nodeId)
    return out.length > 0 && !out.some((e) => !e.when || e.when === s.branch)
  })
}

/**
 * 这次运行还没走完：有节点没完成（失败、暂停、还没开始），或者停在了某个节点的结论上。
 * 主 Agent 是常驻编排器，不算在内（它一直活着，等用户的下一条要求）；用户结束了流程后也不算
 */
export function flowUnfinished(task: FlowTask, w: Workflow | undefined): boolean {
  if (task.mode !== 'workflow' || task.flowClosed) return false
  const flow = taskFlow(task, w)
  const tops = topSteps(task)
  return !tops.length || tops.some((s) => s.status !== 'done' && s.status !== 'skipped') || !!blockedStep(task, flow)
}

/** 让停住的流程接着走：停住的节点重新执行（重新检查），被跳过的节点由流程重新判断；主 Agent 一直在，不用动 */
export function reopenFlow(task: { steps: TaskStep[] }, step: TaskStep) {
  step.status = 'pending'
  step.branch = ''
  step.verdict = ''
  step.endedAt = ''
}
/** 某个节点下面的直接子节点 */
export const childSteps = (task: { steps: TaskStep[] }, id: string) => task.steps.filter((s) => s.parentId === id)
/** 某个节点的所有后代 */
export function stepTree(task: { steps: TaskStep[] }, id: string): TaskStep[] {
  const out: TaskStep[] = []
  const walk = (pid: string) => {
    for (const c of childSteps(task, pid)) (out.push(c), walk(c.id))
  }
  walk(id)
  return out
}
/** 节点属于哪个主流程节点（去掉运行前缀，第 2 次起的节点 id 是 `r2/xxx`） */
export const rootStepId = (id: string) => id.replace(/^r\d+\//, '').split('/')[0]

export const SLOT_LABEL: Record<string, string> = {
  start: t('开始'),
  review: t('验收'),
  end: t('结束'),
  body: t('执行'),
  step: t('步骤'),
  sub: t('子 Agent'),
  call: t('委派'),
}

const stripTitle = (s: string) =>
  s
    .replace(/^\d+\s*[.、．]\s*/, '')
    .replace(/@\S+/g, '')
    .trim()

/**
 * 更早的版本把步骤写在文档的二级标题里（`## 1. 标题 @Agent`）。
 * 迁移成一步接一步的流程，并把这些步骤从文档里拿掉，只留下目标、规范等说明。
 */
export function migrateDocSteps(
  w: { document: string; mainAgentId: string; members: WorkflowMember[] },
  agents: Agent[],
): { flow: Flow; document: string } | null {
  const doc = w.document ?? ''
  const team = [w.mainAgentId, ...w.members.map((m) => m.agentId)]
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[]
  const heads = [...doc.matchAll(/^##\s+(.+)$/gm)]
  if (!heads.length) return null
  const stages: { nodes: Record<string, unknown>[] }[] = []
  const cut: [number, number][] = []
  for (const h of heads) {
    const start = h.index!
    const after = start + h[0].length
    const rest = doc.slice(after)
    const end = rest.search(/^#{1,2}\s/m)
    const stop = end < 0 ? doc.length : after + end
    const who = team.find((a) => h[1].includes(`@${a.name}`))
    const title = stripTitle(h[1]) || h[1].trim()
    stages.push({
      nodes: [
        {
          id: flowId('nd'),
          title: title.slice(0, 60),
          agentId: who && who.id !== w.mainAgentId ? who.id : '',
          instructions: doc.slice(after, stop).trim(),
        },
      ],
    })
    cut.push([start, stop])
  }
  let left = doc
  for (const [a, b] of [...cut].reverse()) left = left.slice(0, a) + left.slice(b)
  // 步骤拿掉后只剩标题的「# 步骤」也一起去掉
  left = left
    .replace(/^#\s*(步骤|流程|执行步骤)\s*\n(\s*\n)*(?=#|$)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { flow: stagesToFlow(stages) as Flow, document: left ? left + '\n' : '' }
}

/** 工作流连同它引用的其他工作流（递归）；任务创建时把这些存一份，之后改动或删除工作流不影响这个任务 */
export function workflowClosure(w: Workflow, workflows: Workflow[]): Workflow[] {
  const out = new Map<string, Workflow>([[w.id, w]])
  const queue = [w]
  while (queue.length) {
    const cur = queue.shift()!
    for (const f of cur.flows)
      for (const r of refsOf(f)) {
        if (r.kind !== 'workflow' || out.has(r.id)) continue
        const other = workflows.find((x) => x.id === r.id)
        if (other) {
          out.set(other.id, other)
          queue.push(other)
        }
      }
  }
  return [...out.values()]
}

/**
 * 任务用的工作流：优先用任务创建时存下的那份，旧任务没有时用现在的。
 * 返回执行的工作流和引用解析用的全部工作流。
 */
export function taskWorkflows(
  task: { workflowId: string; workflows?: Workflow[] },
  current: Workflow[],
): { workflow: Workflow | undefined; workflows: Workflow[] } {
  const snap = task.workflows ?? []
  if (snap.length) {
    const ids = new Set(snap.map((w) => w.id))
    return {
      workflow: snap.find((w) => w.id === task.workflowId),
      workflows: [...snap, ...current.filter((w) => !ids.has(w.id))],
    }
  }
  return { workflow: current.find((w) => w.id === task.workflowId), workflows: current }
}
