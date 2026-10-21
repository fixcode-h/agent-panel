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
import { currentRun, inRun, planTask } from './flow.ts'
import { getLang, t } from './i18n.ts'

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
 * 附件引用标记：旧版输入框会把标记插进文字，发送给 CLI 前换成附件的实际路径。
 * 现在附件只显示成输入框上方的卡片，这里保留是为了继续支持已经存下的带标记的消息。
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
  /** 项目里定的技能槽取值（见 shared/expose.ts 的 exposeSlots） */
  skillSlots: Record<string, string> = {},
): TaskData {
  const wf = input.mode === 'workflow' ? workflow : undefined
  return {
    projectId: input.projectId,
    title: taskTitle(input.prompt),
    mode: input.mode,
    parentTaskId: input.parentTaskId ?? '',
    rootTaskId: input.rootTaskId ?? '',
    summary: '',
    rules: [],
    goal: '',
    childLimit: 0,
    inbox: [],
    workflowId: input.mode === 'workflow' ? (workflow?.id ?? '') : '',
    agentId: input.mode === 'chat' ? input.agentId : '',
    // 默认 Agent 和不用 Agent 角色的对话（agentId 为空）都能在对话时选 CLI 和模型；其他 Agent 用自己配置的
    cli: input.mode === 'chat' && canPickRun(input.agentId) ? (input.cli ?? '') : '',
    model: input.mode === 'chat' && canPickRun(input.agentId) ? (input.model ?? '') : '',
    effort: input.mode === 'chat' && canPickRun(input.agentId) ? (input.effort ?? '') : '',
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
    runs: [],
    skillSlots: wf ? skillSlots : {},
    testSteps: [],
    platform: '',
    workflowName: wf?.name ?? '',
    runSeq: 0,
    requests: [],
    working: false,
    turnDoneAt: '',
    turnSeenAt: '',
    awaitingUser: false,
    prewarming: false,
    worktree: null,
  }
}

/** 开始一轮执行：记下开始时间，结束时累加进 runMs */
export function beginRun(task: { runStartedAt: string }, now = new Date()) {
  task.runStartedAt = now.toISOString()
}

type Pausable = { runStartedAt: string; runMs: number; waitMs: number; waitStartedAt: string }

/**
 * 执行中停在等待上（等用户确认 / 回答 / 下一句）：先把已经跑的执行时间结算进 runMs，
 * 停下的这一刻开始算等待，之后的空闲不再算执行。
 * keepAlive 让一次 CLI 调用一直不返回，不在这里断开的话整段空闲都会被算成执行时间。
 */
export function pauseRun(task: Pausable, now = Date.now()) {
  if (!task.runStartedAt) return
  task.runMs += Math.max(0, now - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
  if (!task.waitStartedAt) task.waitStartedAt = new Date(now).toISOString()
}

/** 等到了（用户回答 / 发来下一句）：等待结算进 waitMs，从这一刻继续算执行 */
export function resumeRun(task: Pausable, now = Date.now()) {
  if (task.waitStartedAt) {
    task.waitMs = (task.waitMs ?? 0) + Math.max(0, now - Date.parse(task.waitStartedAt))
    task.waitStartedAt = ''
  }
  if (!task.runStartedAt) task.runStartedAt = new Date(now).toISOString()
}

export function endRun(
  task: TurnHost & { runMs: number; runStartedAt: string; waitMs: number; waitStartedAt: string; steps: Timed[] },
  now = new Date(),
) {
  if (task.runStartedAt) task.runMs += Math.max(0, now.getTime() - Date.parse(task.runStartedAt))
  task.runStartedAt = ''
  // 停下时还挂着的请求随这一轮结束，等待也到此为止（包含停在等待工具上的那段）
  task.waitMs = waitDuration(task, now.getTime())
  task.waitStartedAt = ''
  for (const o of task.steps) closeWait(o, now.getTime())
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

/**
 * 任务执行了多久（毫秒）：已完成的几段加上正在执行的这一段；停在等用户时 runStartedAt 已经清空，
 * 这段空闲不算执行（见 pauseRun）。旧任务没有记录时按创建到最后更新估算
 */
export function taskDuration(
  task: { status: string; runMs?: number; runStartedAt?: string; createdAt: string; updatedAt: string },
  now = Date.now(),
) {
  const live = task.runStartedAt ? Math.max(0, now - Date.parse(task.runStartedAt)) : 0
  const ms = (task.runMs ?? 0) + live
  if (ms > 0 || task.status === 'running') return ms
  return Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.createdAt))
}

/** 对话里能不能临时选 CLI、模型和思考强度：默认 Agent、以及不用 Agent 角色（空 id）时可以 */
export const canPickRun = (agentId: string) => !agentId || agentId === DEFAULT_AGENT_ID

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
  if (task.mode !== 'chat' || task.agentId !== agent.id || !canPickRun(agent.id)) return agent
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
 * 对话中途换了 CLI、模型（会话里能换模型的 CLI 除外）或（不支持中途换强度的 CLI 换了）思考强度：
 * 原来的会话接不上，要开新会话把之前的对话带过去。
 */
export function sessionChanged(
  task: Pick<Task, 'messages' | 'sessionCli'>,
  cli: string,
  model: string,
  effort = '',
  effortBound = false,
  modelSwitch = false,
) {
  if (task.sessionCli && task.sessionCli !== cli) return true
  const last = [...task.messages].reverse().find((m) => m.run?.cli === cli)
  if (!last?.run) return false
  return (!modelSwitch && last.run.model !== model) || (effortBound && (last.run.effort ?? '') !== effort)
}

/**
 * 用户最近一次发消息的时间，没有就用创建时间。
 * 列表按它排序、显示它：Agent 回复、执行状态变化不改变顺序，只有用户发了新消息才排到前面
 */
export function askedAt(t: Pick<Task, 'messages' | 'createdAt' | 'askedAt'>) {
  let at = t.askedAt ?? ''
  for (const m of t.messages) if (m.role === 'user' && m.at > at) at = m.at
  return at || t.createdAt
}

/** 按用户最近发消息的时间排，新的在前 */
export const byAskedAt = (a: Task, b: Task) => askedAt(b).localeCompare(askedAt(a))

/** 父对话下的子对话入口要显示的信息 */
export interface ChildEntry {
  id: string
  title: string
  working: boolean
  cliAlive: boolean
  lastMessageAt: string
}

/**
 * 子对话列表的顺序：正在执行的排最上面，其余按最近一条消息的时间倒序。
 * 父对话里显示子对话、悬浮窗列表都用它。
 */
export function sortChildren<T extends ChildEntry>(list: T[]): T[] {
  return list.slice().sort((a, b) => {
    if (a.working !== b.working) return a.working ? -1 : 1
    return (b.lastMessageAt || '').localeCompare(a.lastMessageAt || '')
  })
}

/**
 * 任务列表按自然日分组：同一天的归到一组，组内保持传进来的顺序（列表本来就按时间倒序）。
 * 今天、昨天用相对说法，更早的写日期；不是今年的带上年份。
 * now 只有测试会传，正常用当前时间。
 */
export function groupByDay<T>(list: T[], at: (x: T) => string, now = new Date()) {
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = dayStart(now)
  const yesterday = dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const loc = getLang() === 'en' ? 'en-US' : 'zh-CN'
  const groups = new Map<string, { key: string; label: string; items: T[] }>()
  for (const x of list) {
    const d = new Date(at(x))
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    let g = groups.get(key)
    if (!g) {
      const day = dayStart(d)
      g = {
        key,
        label: day === today ? t('今天') : day === yesterday ? t('昨天') : dayLabel(d, now, loc),
        items: [],
      }
      groups.set(key, g)
    }
    g.items.push(x)
  }
  return [...groups.values()]
}

/** 更早那天的写法：今年的不写年份，别的年份写上 */
function dayLabel(d: Date, now: Date, loc: string) {
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(loc, { ...(sameYear ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric' })
}

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
    // 运行记录里有共享状态和节点消息，列表用不到；任务页会取完整内容
    runs: [],
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

/**
 * 结束这次运行：没完成的节点标成跳过，不再执行。
 * 主 Agent 是常驻编排器，一直在；之后的要求交给它处理（可以起新的一次运行）
 */
export function closeFlow(task: Task, id: string, now = new Date().toISOString()) {
  // 只结束这次运行：之前几次运行的节点已经走完，不动
  const run = currentRun(task)
  for (const s of task.steps)
    if (inRun(s.id, run) && s.status !== 'done' && s.status !== 'skipped') {
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
    text: t('这次运行已经结束，没完成的节点不再执行。之后的要求直接跟主角色说，需要时它会再走一遍流程。'),
    tools: [],
    at: now,
  })
  task.updatedAt = now
}
