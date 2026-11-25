import type { Task, WorkflowGrant } from '../schema.ts'
import { canPreset } from './kinds.ts'

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

/** 这条规则是不是工作流自带的：是就返回那一条（卡片不弹，对话里那一行写它的说法） */
export const presetFor = (task: Pick<Task, 'mode' | 'workflowId' | 'workflows'>, rule: string) =>
  rule ? presetGrants(task).find((g) => g.rule === rule) : undefined
