/** 新建任务的初始数据；真实执行和在线演示共用 */
import type { NewTaskInput, TaskData, Workflow } from './schema.ts'
import { planTask } from './flow.ts'

export function taskTitle(prompt: string) {
  const line = prompt.trim().split('\n')[0]
  return line.length > 32 ? line.slice(0, 32) + '…' : line
}

/** 新建任务的初始数据 */
export function newTask(input: NewTaskInput, workflow: Workflow | undefined, now: string, id: string): TaskData {
  return {
    projectId: input.projectId,
    title: taskTitle(input.prompt),
    mode: input.mode,
    workflowId: input.mode === 'workflow' ? (workflow?.id ?? '') : '',
    agentId: input.mode === 'chat' ? input.agentId : '',
    status: 'running',
    ...(input.mode === 'workflow' ? planTask(workflow) : { steps: [] }),
    messages: [{ id, role: 'user', agentId: '', step: '', text: input.prompt.trim(), tools: [], at: now }],
    changes: [],
    simulated: false,
    sessions: {},
    usage: { agents: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    todos: [],
    baseline: {},
    requests: [],
  }
}
