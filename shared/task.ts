/** 新建任务的初始数据；真实执行和在线演示共用 */
import {
  DEFAULT_AGENT_ID,
  type Attachment,
  type NewTaskInput,
  type Task,
  type TaskData,
  type TaskMessage,
  type Workflow,
} from './schema.ts'
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
export function newTask(
  input: NewTaskInput,
  workflow: Workflow | undefined,
  now: string,
  id: string,
  /** 存进任务的工作流（连同引用的其他工作流），见 workflowClosure */
  snapshot: Workflow[] = workflow ? [workflow] : [],
): TaskData {
  const wf = input.mode === 'workflow' ? workflow : undefined
  return {
    projectId: input.projectId,
    title: taskTitle(input.prompt),
    mode: input.mode,
    workflowId: input.mode === 'workflow' ? (workflow?.id ?? '') : '',
    agentId: input.mode === 'chat' ? input.agentId : '',
    // 只有默认 Agent 能在对话时临时换模型；其他 Agent 用自己配置的档位
    model: input.mode === 'chat' && input.agentId === DEFAULT_AGENT_ID ? (input.model ?? '') : '',
    effort: input.mode === 'chat' && input.agentId === DEFAULT_AGENT_ID ? (input.effort ?? '') : '',
    status: 'running',
    runMs: 0,
    runStartedAt: now,
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
    command: [],
    usage: { agents: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    todos: [],
    baseline: {},
    baseRef: '',
    workflows: wf ? snapshot : [],
    workflowName: wf?.name ?? '',
    requests: [],
    queue: [],
    worktree: null,
  }
}

/** 开始一轮执行：记下开始时间，结束时累加进 runMs */
export function beginRun(task: { runStartedAt: string }, now = new Date()) {
  task.runStartedAt = now.toISOString()
}
export function endRun(task: { runMs: number; runStartedAt: string }, now = new Date()) {
  if (task.runStartedAt) task.runMs += Math.max(0, now.getTime() - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
}

/** 任务执行了多久（毫秒）：已完成的几轮加上正在执行的这一轮；旧任务没有记录时按创建到最后更新估算 */
export function taskDuration(
  task: { status: string; runMs?: number; runStartedAt?: string; createdAt: string; updatedAt: string },
  now = Date.now(),
) {
  const live = task.status === 'running' && task.runStartedAt ? Math.max(0, now - Date.parse(task.runStartedAt)) : 0
  const ms = (task.runMs ?? 0) + live
  if (ms > 0 || task.status === 'running') return ms
  return Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.createdAt))
}

/** 对话任务给默认 Agent 临时选的模型和思考强度 */
export function withTaskModel<A extends { id: string; model: string; effort: string }>(
  agent: A,
  task: { mode: string; agentId: string; model?: string; effort?: string },
): A {
  if (task.mode !== 'chat' || task.agentId !== agent.id || agent.id !== DEFAULT_AGENT_ID) return agent
  return { ...agent, model: task.model || agent.model, effort: task.effort || agent.effort }
}

/**
 * 列表用的任务摘要：侧栏、项目首页只要标题、状态、进度和用量。去掉消息内容、节点输出这些大块数据，
 * 只留第一条要求（截短）给搜索用。打开任务时再取完整内容。
 */
export function taskSummary(t: Task): Task {
  const first = t.messages.find((m) => m.role === 'user')
  return {
    ...t,
    messages: first ? [{ ...first, text: first.text.slice(0, 500), tools: [] }] : [],
    steps: t.steps.map((s) => ({ ...s, output: '', command: [] })),
    todos: [],
    baseline: {},
    sessions: {},
    command: [],
    workflows: [],
    workflowName: t.workflowName || t.workflows.find((w) => w.id === t.workflowId)?.name || '',
  }
}

/** 消息的指纹：文字、思考、工具和工具输出有变化时会变，推送增量时用来判断哪些消息要重发 */
export function messageStamp(m: TaskMessage) {
  return `${m.text.length}|${m.thinking?.length ?? 0}|${m.error ? 1 : 0}|${m.tools
    .map((t) => `${t.output?.length ?? 0}${t.failed ? 'x' : ''}${t.input?.length ?? 0}`)
    .join(',')}`
}
