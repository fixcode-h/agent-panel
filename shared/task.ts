/** 新建任务的初始数据；真实执行和在线演示共用 */
import {
  DEFAULT_AGENT_ID,
  type Attachment,
  type FileChange,
  type NewTaskInput,
  type StepUsage,
  type Task,
  type TaskData,
  type TaskMessage,
  type TaskRequest,
  type Workflow,
} from './schema.ts'
import { getCli } from './clis.ts'
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
    // 只有默认 Agent 能在对话时选 CLI 和模型；其他 Agent 用自己配置的
    cli: input.mode === 'chat' && input.agentId === DEFAULT_AGENT_ID ? (input.cli ?? '') : '',
    model: input.mode === 'chat' && input.agentId === DEFAULT_AGENT_ID ? (input.model ?? '') : '',
    effort: input.mode === 'chat' && input.agentId === DEFAULT_AGENT_ID ? (input.effort ?? '') : '',
    askUser: input.askUser ?? false,
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

/** 对话里显示的名字：用默认 Agent 选了 CLI 的对话显示 CLI 的名字（用户选的就是 CLI） */
export function chatName(agent: { id: string; name: string } | undefined, task: { cli?: string }) {
  if (!agent) return ''
  return (agent.id === DEFAULT_AGENT_ID && task.cli && getCli(task.cli)?.name) || agent.name
}

/** 对话任务给默认 Agent 选的 CLI、模型和思考强度 */
export function withTaskModel<A extends { id: string; cli: string; model: string; effort: string }>(
  agent: A,
  task: { mode: string; agentId: string; cli?: string; model?: string; effort?: string },
): A {
  if (task.mode !== 'chat' || task.agentId !== agent.id || agent.id !== DEFAULT_AGENT_ID) return agent
  // 换了 CLI 时不能沿用默认 Agent 原来的模型（那是另一个 CLI 的）
  const cli = task.cli || agent.cli
  const same = cli === agent.cli
  return {
    ...agent,
    cli,
    model: task.model || (same ? agent.model : ''),
    effort: task.effort || (same ? agent.effort : ''),
  }
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
    steps: t.steps.map(({ usage, ...s }) => ({ ...s, output: '', command: [], changes: [] })),
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

/** 把一次调用的改动累加到列表里（同一个文件合并行数） */
export function mergeChanges(into: FileChange[], add: FileChange[]) {
  for (const c of add) {
    const old = into.find((x) => x.path === c.path)
    if (old) {
      old.add += c.add
      old.del += c.del
    } else into.push({ ...c })
  }
}

/**
 * 节点执行期间新增的改动：节点结束后和开始前的统计（都相对任务开始时）相减。
 * 同时在跑的节点改了同一个文件时分不清是谁改的，算在先结束的节点上
 */
export function changesSince(before: FileChange[], after: FileChange[]): FileChange[] {
  const out: FileChange[] = []
  for (const c of after) {
    const b = before.find((x) => x.path === c.path)
    const add = c.add - (b?.add ?? 0)
    const del = c.del - (b?.del ?? 0)
    if (add > 0 || del > 0) out.push({ path: c.path, add: Math.max(0, add), del: Math.max(0, del) })
  }
  return out
}

/** 节点的用量记录，没有就建一条 */
export function stepUsage(step: { usage?: StepUsage }, model = ''): StepUsage {
  return (step.usage ??= {
    context: 0,
    window: 0,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  })
}

/** 用户回答了 Agent 的提问：每个问题和答案，在对话正文里显示；没回答（交给 AI 自己决定）时为空 */
export function questionAnswers(
  req: Pick<TaskRequest, 'title' | 'questions'>,
  r: { allow: boolean; answer?: string; answers?: string[] },
): { question: string; answer: string }[] | undefined {
  if (!r.allow) return undefined
  const qs = req.questions?.length ? req.questions.map((q) => q.question) : [req.title]
  const got = r.answers?.length ? r.answers : [r.answer ?? '']
  return qs.map((question, i) => ({ question, answer: got[i] ?? '' }))
}

/**
 * 模型偶尔把工具调用的原始写法（<invoke name=…>、<parameter name=…>）当成文字说出来，
 * 内容和工具调用的折叠块重复，一大段参数堆在正文里很难看：显示时去掉。
 * 从第一个这样的标记去掉到最后一个结束标记；没有结束标记（流式输出到一半、或者只写了半截）时去掉到结尾。
 * 代码块和行内代码里的不算：那是在正经讲 XML
 */
const TOOL_OPEN =
  /<\/?(?:[\w-]+:)?(?:function_calls|invoke|parameter)\b[^>\n]*>|(?:^|(?<=\s))(?:invoke|parameter) name="[^"\n]*"[^>\n]*>/m
const TOOL_CLOSE = /<\/(?:[\w-]+:)?(?:function_calls|invoke|parameter)>/g

export function stripToolMarkup(text: string) {
  if (!/invoke|parameter|function_calls/.test(text)) return text
  // 代码换成等长的空白再找，下标和原文对得上
  const plain = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (m) => ' '.repeat(m.length))
  const open = TOOL_OPEN.exec(plain)
  if (!open) return text
  let end = text.length
  let last: RegExpExecArray | null = null
  TOOL_CLOSE.lastIndex = open.index
  for (let m = TOOL_CLOSE.exec(plain); m; m = TOOL_CLOSE.exec(plain)) last = m
  if (last) end = last.index + last[0].length
  return (text.slice(0, open.index).trimEnd() + '\n\n' + text.slice(end).trimStart()).trim()
}
