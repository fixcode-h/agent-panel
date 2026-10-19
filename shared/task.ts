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
  type TaskTurn,
  type Workflow,
} from './schema.ts'
import { getCli } from './clis.ts'
import { planTask } from './flow.ts'
import { t } from './i18n.ts'

export function taskTitle(prompt: string) {
  // 标题里不放附件引用，用户写的第一句话才是标题；只发了附件时仍用原文
  const raw = prompt.trim().split('\n')[0]
  const line =
    raw
      .replace(/\[(?:图片|文件):[^\]]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || raw
  return line.length > 32 ? line.slice(0, 32) + '…' : line
}

/**
 * 输入框里引用附件用的标记：粘贴、拖入、选择文件时插到光标处，发送给 CLI 前换成附件的实际路径。
 * 页面上存的是这个标记，用户回头看消息时能看出引用的是哪张图。
 */
export function attachmentRef(a: Pick<Attachment, 'name' | 'mime'>) {
  const image = a.mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name)
  return `[${image ? '图片' : '文件'}:${a.name}]`
}

/**
 * 交给 Agent 的要求：文字里引用到的附件在原来的位置换成路径；没引用到的仍然列在后面。
 * CLI 用自己的读文件工具去读（Claude Code、Codex 都能直接看图片）
 */
export function withAttachments(prompt: string, attachments: Attachment[] | undefined) {
  if (!attachments?.length) return prompt
  let text = prompt
  const used = new Set<Attachment>()
  // 名字长的先换：一个名字是另一个的前缀时不会换错
  for (const a of [...attachments].sort((x, y) => y.name.length - x.name.length)) {
    const ref = attachmentRef(a)
    if (!text.includes(ref)) continue
    text = text.split(ref).join(a.path)
    used.add(a)
  }
  const rest = attachments.filter((a) => !used.has(a))
  if (!rest.length) return text
  const list = rest.map((a) => `- ${a.name}：${a.path}`).join('\n')
  return `${text}\n\n## 附件\n用户附上了这些文件，需要时直接读取：\n${list}`
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
    params: input.mode === 'chat' ? (input.params ?? {}) : {},
    status: 'running',
    runMs: 0,
    runStartedAt: now,
    waitMs: 0,
    waitStartedAt: '',
    turns: [],
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
    awaitingUser: false,
    prewarming: false,
    worktree: null,
  }
}

/** 开始一轮执行：记下开始时间，结束时累加进 runMs */
export function beginRun(task: { runStartedAt: string }, now = new Date()) {
  task.runStartedAt = now.toISOString()
}
export function endRun(task: TurnHost & { runMs: number; runStartedAt: string; steps: Timed[] }, now = new Date()) {
  if (task.runStartedAt) task.runMs += Math.max(0, now.getTime() - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
  // 停下时还挂着的请求随这一轮结束，等待也到此为止
  for (const o of [task, ...task.steps]) closeWait(o, now.getTime())
  for (const turn of task.turns ?? []) if (turn.status === 'running') endTurn(task, turn, 'stopped', now.getTime())
}

type TurnHost = Timed & {
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
  turns: TaskTurn[]
}

/** 开始一轮追加要求 / 对话：记下开始时间和这时的累计用量 */
export function beginTurn(task: TurnHost, id: string, prompt: string, agentId: string, now = Date.now()) {
  const line = prompt.trim().split('\n')[0] ?? ''
  const turn: TaskTurn = {
    id,
    title: line.length > 60 ? line.slice(0, 60) + '…' : line,
    agentId,
    status: 'running',
    startedAt: new Date(now).toISOString(),
    endedAt: '',
    from: {
      inputTokens: task.usage.inputTokens,
      outputTokens: task.usage.outputTokens,
      cacheReadTokens: task.usage.cacheReadTokens ?? 0,
      waitMs: waitDuration(task, now),
    },
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    waitMs: 0,
  }
  ;(task.turns ??= []).push(turn)
  return turn
}

/** 一轮的用量和等待：结束了用记下的，执行中按现在的累计减去开始时的 */
export function turnStats(task: TurnHost, turn: TaskTurn, now = Date.now()) {
  if (turn.status !== 'running') return turn
  return {
    inputTokens: Math.max(0, task.usage.inputTokens - turn.from.inputTokens),
    outputTokens: Math.max(0, task.usage.outputTokens - turn.from.outputTokens),
    cacheReadTokens: Math.max(0, (task.usage.cacheReadTokens ?? 0) - turn.from.cacheReadTokens),
    waitMs: Math.max(0, waitDuration(task, now) - turn.from.waitMs),
  }
}

export function endTurn(task: TurnHost, turn: TaskTurn, status: TaskTurn['status'], now = Date.now()) {
  if (turn.status !== 'running') return
  Object.assign(turn, turnStats(task, turn, now), { status, endedAt: new Date(now).toISOString() })
}

type Timed = { waitMs: number; waitStartedAt: string }
type Waiting = Timed & { requests: { step: string; at: string }[]; steps: (Timed & { id: string })[] }

function closeWait(o: Timed, now: number) {
  if (!o.waitStartedAt) return
  o.waitMs = (o.waitMs ?? 0) + Math.max(0, now - Date.parse(o.waitStartedAt))
  o.waitStartedAt = ''
}

/**
 * 记等用户的时间：有请求挂着（权限确认、提问、节点完成后的确认）就开始计，全部处理完时累加。
 * 任务和请求所在的节点各记一份。每次任务有变化时调用，开始时间取请求发出的时间，不受调用时机影响
 */
export function trackWait(task: Waiting, now = Date.now()) {
  const tick = (o: Timed, reqs: { at: string }[]) => {
    if (!reqs.length) return closeWait(o, now)
    if (o.waitStartedAt) return
    const at = Math.min(now, ...reqs.map((r) => Date.parse(r.at)).filter(Number.isFinite))
    o.waitStartedAt = new Date(at).toISOString()
  }
  const reqs = task.requests ?? []
  tick(task, reqs)
  for (const s of task.steps)
    if (s.waitStartedAt || reqs.some((r) => r.step === s.id))
      tick(
        s,
        reqs.filter((r) => r.step === s.id),
      )
}

/** 等用户的总时间（毫秒），含正在等的这一段 */
export function waitDuration(o: Partial<Timed>, now = Date.now()) {
  return (o.waitMs ?? 0) + (o.waitStartedAt ? Math.max(0, now - Date.parse(o.waitStartedAt)) : 0)
}

/** 节点执行了多久（毫秒）：之前被打断时做的部分加上这一次的；没开始过为 0 */
export function stepMs(
  step: { startedAt: string; endedAt: string; status: string; spentMs?: number },
  now = Date.now(),
) {
  const end = step.endedAt ? Date.parse(step.endedAt) : step.status === 'running' ? now : 0
  const cur = step.startedAt && end ? Math.max(0, end - Date.parse(step.startedAt)) : 0
  return (step.spentMs ?? 0) + cur
}

/** 节点被停止或打断：已经做的时间记进 spentMs，续接时接着算 */
export function pauseStep(step: { startedAt: string; spentMs: number }, now = Date.now()) {
  if (step.startedAt) step.spentMs = (step.spentMs ?? 0) + Math.max(0, now - Date.parse(step.startedAt))
  step.startedAt = ''
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
 * 用户最近一次发消息的时间（含排队还没处理的），没有就用创建时间。
 * 列表按它排序、显示它：Agent 回复、执行状态变化不改变顺序，只有用户发了新消息才排到前面
 */
export function askedAt(t: Pick<Task, 'messages' | 'createdAt' | 'askedAt'> & { queue?: { at: string }[] }) {
  let at = t.askedAt ?? ''
  for (const m of t.messages) if (m.role === 'user' && m.at > at) at = m.at
  for (const q of t.queue ?? []) if (q.at > at) at = q.at
  return at || t.createdAt
}

/** 按用户最近发消息的时间排，新的在前 */
export const byAskedAt = (a: Task, b: Task) => askedAt(b).localeCompare(askedAt(a))

/**
 * 列表用的任务摘要：侧栏、项目首页只要标题、状态、进度和用量。去掉消息内容、节点输出这些大块数据，
 * 只留第一条要求（截短）给搜索用。打开任务时再取完整内容。
 */
export function taskSummary(t: Task): Task {
  const first = t.messages.find((m) => m.role === 'user')
  return {
    ...t,
    askedAt: askedAt(t),
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

/**
 * 继续执行前去掉上一轮结束时写的状态说明（已暂停、失败后可以重试）：接着跑以后它已经不成立，
 * 留着还会把同一个节点的前后输出隔成两段
 */
export function dropEndNotes(task: Pick<Task, 'messages'>) {
  while (task.messages.at(-1)?.transient) task.messages.pop()
}

/** 结束工作流：没完成的节点标成跳过，不再执行；之后的要求由主 Agent 直接处理。真实执行和在线演示共用 */
export function closeFlow(task: Task, id: string, now = new Date().toISOString()) {
  for (const s of task.steps)
    if (s.status !== 'done' && s.status !== 'skipped') {
      s.status = 'skipped'
      s.interrupted = false
    }
  task.flowClosed = true
  // 用户主动结束的：不再显示成失败、暂停
  if (task.status === 'failed' || task.status === 'stopped') task.status = 'done'
  task.messages.push({
    id,
    role: 'system',
    agentId: '',
    step: '',
    text: t('已结束流程，没完成的节点不再执行。之后输入的要求由主 Agent 直接处理。'),
    tools: [],
    at: now,
  })
  task.updatedAt = now
}
