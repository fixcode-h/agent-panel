/**
 * 保存和删除前的检查：服务端和在线演示的模拟后端共用，两边的规则和提示一致。
 */
import { END, RESERVED_STEP_IDS, START, findRefCycle, nodeSteps } from './flow.ts'
import { DEFAULT_AGENT_ID, type Project, type ProjectCategory, type Workflow, type WorkflowInput } from './schema.ts'
import { t } from './i18n.ts'
import { DEFAULT_WORKFLOW_ID } from './builtin/default.ts'

/** 流程图里有没有环；有就返回环上的节点名 */
export function cycleIn(f: { nodes: { id: string; title: string }[]; edges: { from: string; to: string }[] }) {
  const state = new Map<string, 1 | 2>()
  const name = (id: string) => f.nodes.find((n) => n.id === id)?.title.trim() || id
  const visit = (id: string, path: string[]): string | null => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id].map(name).join(' → ')
    state.set(id, 1)
    for (const e of f.edges)
      if (e.from === id) {
        const c = visit(e.to, [...path, id])
        if (c) return c
      }
    state.set(id, 2)
    return null
  }
  for (const n of f.nodes) {
    const c = visit(n.id, [])
    if (c) return c
  }
  return null
}

/**
 * 检查并整理要保存的工作流（原地修改）：去掉不存在或重复的成员、悬空和重复的连线，
 * 不存在的节点 Agent 改由主 Agent 执行。有问题时返回提示，没问题返回 null
 */
export function checkWorkflow(
  wf: WorkflowInput,
  agentIds: Set<string>,
  others: Workflow[],
  selfId = '',
): string | null {
  if (wf.mainAgentId && !agentIds.has(wf.mainAgentId)) return t('主 Agent 不存在')
  // 去掉不存在的、重复的成员，以及和主 Agent 相同的成员
  const seen = new Set<string>([wf.mainAgentId])
  wf.members = wf.members.filter((m) => agentIds.has(m.agentId) && !seen.has(m.agentId) && !!seen.add(m.agentId))
  if (!wf.flows.length) return t('工作流至少要有一个流程')
  if (!wf.flows.some((f) => f.id === wf.entryFlowId)) wf.entryFlowId = wf.flows[0].id
  if (new Set(wf.flows.map((f) => f.id)).size !== wf.flows.length) return t('流程 id 重复')
  for (const f of wf.flows) {
    const nodeIds = new Set(f.nodes.map((n) => n.id))
    if (nodeIds.size !== f.nodes.length) return t('流程「{flow}」里有重复的节点 id', { flow: f.name })
    if (nodeIds.has(START) || nodeIds.has(END)) return t('流程「{flow}」的节点 id 不能是 start / end', { flow: f.name })
    // 节点指定的 Agent 不存在时改由主 Agent 执行
    for (const n of f.nodes) {
      if (n.agentId && !agentIds.has(n.agentId)) n.agentId = ''
      if (!n.steps.length) continue
      if (new Set(n.steps.map((s) => s.id)).size !== n.steps.length)
        return t('节点「{node}」里有重复的步骤 id', { node: n.title || n.id })
      for (const s of n.steps) {
        if (RESERVED_STEP_IDS.includes(s.id))
          return t('节点「{node}」的步骤 id「{id}」不能用 {reserved}', {
            node: n.title || n.id,
            id: s.id,
            reserved: RESERVED_STEP_IDS.join('、'),
          })
        if (s.agentId && !agentIds.has(s.agentId)) s.agentId = ''
      }
    }
    // 去掉悬空、重复、方向不对的连线
    const keys = new Set<string>()
    f.edges = f.edges.filter((e) => {
      const k = `${e.from}>${e.to}`
      const ok =
        (e.from === START || nodeIds.has(e.from)) &&
        (e.to === END || nodeIds.has(e.to)) &&
        e.from !== e.to &&
        !keys.has(k)
      keys.add(k)
      return ok
    })
    const cyc = cycleIn(f)
    if (cyc) return t('流程「{flow}」里的节点连成了环：{cycle}，执行时会一直等不到上游', { flow: f.name, cycle: cyc })
  }
  const cycle = findRefCycle(
    { ...wf, id: selfId || '__new__', createdAt: '', updatedAt: '' },
    others.filter((x) => x.id !== selfId),
  )
  return cycle ? t('流程之间循环调用：{cycle}', { cycle: cycle.join(' → ') }) : null
}

/** 能不能删这个 Agent：自带的默认 Agent 不能删，被工作流用着的要先移除 */
export function agentDeleteError(id: string, workflows: Workflow[]): string | null {
  if (id === DEFAULT_AGENT_ID) return t('默认 Agent 是自带的，不能删除')
  const used = workflows.filter(
    (w) =>
      w.mainAgentId === id ||
      w.members.some((m) => m.agentId === id) ||
      w.flows.some((f) => f.nodes.some((n) => nodeSteps(n).some((s) => s.agentId === id))),
  )
  return used.length
    ? t('正在被工作流使用：{names}，请先从工作流中移除', {
        names: used.map((w) => t('「{name}」', { name: w.name })).join(t('、')),
      })
    : null
}

/** 能不能删这个工作流：项目分类或项目还在用它时不能删 */
export function workflowDeleteError(id: string, categories: ProjectCategory[], projects: Project[]): string | null {
  if (id === DEFAULT_WORKFLOW_ID) return t('默认工作流是自带的，不能删除')
  const users = [
    ...categories.filter((x) => x.workflowId === id).map((x) => t('项目分类「{name}」', { name: x.name })),
    ...projects.filter((x) => x.workflowId === id).map((x) => t('项目「{name}」', { name: x.name })),
  ]
  return users.length ? t('正在被使用：{names}，请先改用其他工作流', { names: users.join(t('、')) }) : null
}
