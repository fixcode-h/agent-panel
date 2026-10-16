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
  type TaskStep,
  type Workflow,
  type WorkflowInput,
  type WorkflowMember,
} from './schema.ts'

const rand = () => Math.random().toString(36).slice(2, 10)
export const flowId = (prefix: 'nd' | 'e' | 'fl') => `${prefix}_${rand()}`
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
    hooks: { start: null, review: null, end: null, maxRounds: 3 },
    ...o,
  }
}

export const getFlow = (w: Pick<WorkflowInput, 'flows'>, id: string) => w.flows.find((f) => f.id === id)
/** 主流程：任务从这里开始 */
export const entryFlow = (w: Pick<WorkflowInput, 'flows' | 'entryFlowId'>) => getFlow(w, w.entryFlowId) ?? w.flows[0]
export const flowLabel = (f: Flow, w: Pick<WorkflowInput, 'entryFlowId'>) =>
  f.name.trim() || (f.id === w.entryFlowId ? '主流程' : '未命名子流程')

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
  const plan = n('分析需求、拆分任务', '', '阅读需求和相关代码，列出要改动的部分、每个节点的分工和验收标准。')
  const work = members.length
    ? members.map((m) =>
        n(
          (m.responsibility || m.agent.description || m.agent.name).slice(0, 60),
          m.agent.id,
          '按分析阶段的分工完成自己负责的部分，只改自己负责的文件，完成后说明改了什么。',
        ),
      )
    : [n('实现', '', '按分析阶段的结论完成改动，并自测。')]
  const check = n('验收', '', '逐条对照验收标准检查结果，列出没满足的地方。')
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
    return f ? flowLabel(f, w) : '（流程已删除）'
  }
  return workflows.find((x) => x.id === ref.id)?.name ?? '（工作流已删除）'
}

/** 一个流程直接引用的流程 */
export function refsOf(f: Flow): FlowRef[] {
  return f.nodes.flatMap((n) =>
    [n.kind === 'flow' ? n.flow : null, n.hooks.start, n.hooks.review, n.hooks.end].filter((r): r is FlowRef => !!r),
  )
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
    output: '',
    verdict: '',
    rounds: 0,
    ...o,
  }
}

/** 把工作流的主流程展开成任务节点（子流程在执行时才展开） */
export function planTask(workflow: Workflow | undefined): { steps: TaskStep[] } {
  if (!workflow) return { steps: [] }
  const flow = entryFlow(workflow)
  return {
    steps: topoOrder(flow).map((n, i) =>
      blankStep({
        id: n.id,
        workflowId: workflow.id,
        flowId: flow.id,
        nodeId: n.id,
        kind: n.kind,
        title: n.title.trim() || `节点 ${i + 1}`,
        agentId: n.kind === 'agent' ? nodeAgent(workflow, n.agentId) : '',
      }),
    ),
  }
}

/** 任务里主流程的节点（不含子节点） */
export const topSteps = (task: { steps: TaskStep[] }) => task.steps.filter((s) => !s.parentId)
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
/** 节点属于哪个主流程节点 */
export const rootStepId = (id: string) => id.split('/')[0]

export const SLOT_LABEL: Record<string, string> = { start: '开始', review: '验收', end: '结束', body: '执行' }

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
