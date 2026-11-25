import type { Task, WorkflowGrant } from '../schema.ts'
import { canPreset } from './kinds.ts'

type GrantTask = Pick<Task, 'mode' | 'workflowId' | 'workflows'> & Partial<Pick<Task, 'steps'>>

/**
 * 工作流自带的授权（WorkflowFields.grants，用户 2026-11-25）：对话是这个工作流的运行时，这些规则键按「本对话不再询问」算。
 * 只看对话自己存的工作流快照（task.workflows 里 id 对得上 task.workflowId 的那一份，旧任务退回第一份），
 * 之后改了工作流不影响已经开始的运行；普通对话（不是工作流）没有自带授权
 */
export function presetGrants(task: Pick<Task, 'mode' | 'workflowId' | 'workflows'>): WorkflowGrant[] {
  if (task.mode !== 'workflow') return []
  const w = task.workflows.find((x) => x.id === task.workflowId) ?? task.workflows[0]
  return (w?.grants ?? []).filter((g) => canPreset(g.rule))
}

/**
 * 节点自带的授权（FlowNode.grants，复盘 2026-11-25 C1）：只在跑那个节点时算。step 是发起确认的执行记录 id，
 * 节点里的步骤、验收流程、派出的子任务的记录 id 都以节点那条记录的 id 开头，所以按前缀往上找到节点
 */
export function nodeGrants(task: GrantTask, step: string): WorkflowGrant[] {
  if (task.mode !== 'workflow' || !step || !task.steps) return []
  return task.steps
    .filter((s) => s.nodeId && (s.id === step || step.startsWith(`${s.id}/`)))
    .flatMap((s) => {
      const w = task.workflows.find((x) => x.id === s.workflowId) ?? task.workflows[0]
      const flow =
        w?.flows.find((f) => f.id === s.flowId) ?? w?.flows.find((f) => f.nodes.some((n) => n.id === s.nodeId))
      return flow?.nodes.find((n) => n.id === s.nodeId)?.grants ?? []
    })
    .filter((g) => canPreset(g.rule))
}

/** 这条规则是不是工作流（或正在跑的节点）自带的：是就返回那一条（卡片不弹，对话里那一行写它的说法） */
export const presetFor = (task: GrantTask, rule: string, step = '') =>
  rule ? [...presetGrants(task), ...nodeGrants(task, step)].find((g) => g.rule === rule) : undefined
