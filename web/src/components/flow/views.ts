import type { Agent, Flow, FlowRef, Workflow, WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { flowLabel, nodeAgent, reachable, refLabel } from '@shared/flow'
import { plainLine } from '@/lib/tasks'
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
      const agent = byId.get(nodeAgent(w, n.agentId))
      const hooks = (['start', 'review', 'end'] as HookSlot[])
        .filter((s) => n.hooks[s])
        .map((s) => ({
          slot: s,
          label: refLabel(n.hooks[s], w, workflows),
          extra: s === 'review' ? t('≤{n} 轮', { n: n.hooks.maxRounds }) : undefined,
        }))
      const view: NodeView = {
        title: n.title.trim() || (n.kind === 'flow' ? t('调用流程') : t('未命名节点')),
        kind: n.kind,
        agent,
        sub: agent
          ? `${agent.name}${n.agentId ? '' : ` · ${t('主 Agent')}`} · ${modelOf(agent)}`
          : t('还没有选择主 Agent'),
        main: !n.agentId,
        model: agent ? modelOf(agent) : undefined,
        flowText: refLabel(n.flow, w, workflows),
        note: plainLine(n.instructions),
        hooks,
        loose: !live.has(n.id),
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
