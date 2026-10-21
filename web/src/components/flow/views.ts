import type { Agent, Flow, FlowRef, Workflow, WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { flowLabel, nodeAgent, nodeSteps, reachable, refLabel } from '@shared/flow'
import { plainLine } from '@/lib/tasks'
import { nodeAgentRun } from '@shared/agent-role'
import type { HookSlot, NodeView } from './FlowCanvas'

type W = Pick<WorkflowInput, 'flows' | 'entryFlowId' | 'mainAgentId'>

/** 画布上每个节点显示的内容 */
export function nodeViews(
  flow: Flow,
  w: W,
  workflows: Pick<Workflow, 'id' | 'name'>[],
  agents: Agent[],
  modelOf: (a: Agent) => string,
): Record<string, NodeView> {
  const live = reachable(flow)
  const byId = new Map(agents.map((a) => [a.id, a]))
  return Object.fromEntries(
    flow.nodes.map((n) => {
      const units = nodeSteps(n)
      const first = units[0]
      // 节点固定用默认 CLI 的档位：画布上显示的模型、颜色按实际执行的第一个 Agent 算
      const found = byId.get(nodeAgent(w, first.agentId))
      const agent = found && first.kind === 'agent' ? nodeAgentRun(found, first.tier) : found
      const stepName = (u: (typeof units)[number]) =>
        u.title.trim() ||
        (u.kind === 'flow'
          ? refLabel(u.flow, w, workflows) || t('调用流程')
          : byId.get(nodeAgent(w, u.agentId))?.name || t('主角色'))
      const reviewRef = n.steps.length ? (n.steps.find((s) => s.review)?.review ?? null) : n.hooks.review
      const maxRounds = n.steps.length
        ? Math.max(1, ...n.steps.filter((s) => s.review).map((s) => s.maxRounds))
        : n.hooks.maxRounds
      const hooks = (['start', ...(reviewRef ? ['review'] : []), 'end'] as HookSlot[]).map((s) => ({
        slot: s,
        label: refLabel(s === 'review' ? reviewRef : n.hooks[s], w, workflows),
        extra: s === 'review' ? t('≤{n} 轮', { n: maxRounds }) : undefined,
      }))
      const multi = units.length > 1
      const view: NodeView = {
        title: n.title.trim() || (first.kind === 'flow' ? t('调用流程') : t('未命名节点')),
        kind: first.kind,
        agent,
        sub: multi
          ? units.map(stepName).join(' → ')
          : agent
            ? `${agent.name}${first.agentId ? '' : ` · ${t('主角色')}`} · ${modelOf(agent)}`
            : t('还没有选择主角色'),
        main: !first.agentId,
        model: agent ? modelOf(agent) : undefined,
        flowText: refLabel(first.flow, w, workflows),
        note: plainLine(n.instructions || first.instructions),
        hooks,
        loose: !live.has(n.id),
        confirm: n.steps.length ? n.steps.some((s) => s.confirm) : !!n.hooks.confirm,
        count: units.length,
      }
      return [n.id, view]
    }),
  )
}

export const refValue = (r: FlowRef | null) => (r ? `${r.kind}:${r.id}` : '')
export const parseRef = (v: string): FlowRef | null => {
  const i = v.indexOf(':')
  return i > 0 ? { kind: v.slice(0, i) as FlowRef['kind'], id: v.slice(i + 1) } : null
}

/** 可以挂到节点上的流程：本工作流的其他流程（不含当前流程）和其他工作流 */
export function refOptions(
  w: Pick<WorkflowInput, 'flows' | 'entryFlowId'> & { id: string },
  workflows: Pick<Workflow, 'id' | 'name'>[],
  currentFlowId: string,
  empty = t('不配置'),
) {
  return [
    { value: '', label: empty },
    ...w.flows
      .filter((f) => f.id !== currentFlowId)
      .map((f) => ({ value: `sub:${f.id}`, label: flowLabel(f, w), group: t('这个工作流的流程') })),
    ...workflows
      .filter((x) => x.id !== w.id)
      .map((x) => ({ value: `workflow:${x.id}`, label: x.name, group: t('其他工作流') })),
  ]
}
