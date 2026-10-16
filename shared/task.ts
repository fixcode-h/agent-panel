/** 新建任务的初始数据；真实执行和在线演示共用 */
import type { Attachment, NewTaskInput, TaskData, Workflow } from './schema.ts'
import { planTask } from './flow.ts'

export function taskTitle(prompt: string) {
  const line = prompt.trim().split('\n')[0]
  return line.length > 32 ? line.slice(0, 32) + '…' : line
}

/**
 * 交给 Agent 的要求：附件不塞进消息正文（页面上单独显示），执行时在要求后面列出路径，
 * CLI 用自己的读文件工具去读（Claude Code、Codex 都能直接看图片）
 */
export function withAttachments(prompt: string, attachments: Attachment[] | undefined) {
  if (!attachments?.length) return prompt
  const list = attachments.map((a) => `- ${a.name}：${a.path}`).join('\n')
  return `${prompt}\n\n## 附件\n用户附上了这些文件，需要时直接读取：\n${list}`
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
    messages: [
      {
        id,
        role: 'user',
        agentId: '',
        step: '',
        text: input.prompt.trim(),
        tools: [],
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        at: now,
      },
    ],
    changes: [],
    simulated: false,
    sessions: {},
    usage: { agents: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    todos: [],
    baseline: {},
    requests: [],
  }
}
