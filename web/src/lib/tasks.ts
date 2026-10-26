import type { PeerKind, Task, TaskJob, TaskMessage, TaskStatus, TaskStep, ToolUse } from '@shared/schema'
import { SLOT_LABEL, topSteps } from '@shared/flow'
import { getLang, t } from '@shared/i18n'
import { stepMs } from '@shared/task'
import { fmtDuration } from '@shared/duration'
import { cacheHitRate } from '@shared/task-export'
import { tokenCount, type RunUsage } from '@shared/run-usage'
import { PANEL_TOOL_NAMES, bgJobIds, bgPendingIds } from '@shared/panel-tools'

export const statusLabel: Record<TaskStatus, string> = {
  running: t('执行中'),
  done: t('已完成'),
  stopped: t('已暂停'),
  failed: t('失败'),
}

/** 「3 分钟前」这类相对时间：实现在 shared/task（服务端给父对话的清单也用它），这里只转出去 */
export { timeAgo } from '@shared/task'

export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

/**
 * 实时速度：只算正在输出的 Agent 的 token/s（工作流里可能几个节点同时输出），没在输出就是 0。
 * 实现在 shared/run-usage（和「整个运行」的分层同一条规则）：不拿 lastTps 冒充实时速度。
 */
export { tpsNow } from '@shared/run-usage'

/**
 * Token 浮层里的分组：有子对话或派出的子任务时才分开列「本对话」「子任务与子对话」，
 * 没有时返回空数组，浮层退化成只显示总数和输入输出（不出现「子任务 0」这种噪音行）。
 * 两行的速度都是实时值，加起来就是整体的速度（停下的部分不贡献速度）。
 */
export function tokenGroups(
  run: Pick<RunUsage, 'own' | 'sub' | 'tps' | 'subTps' | 'children' | 'helpers'>,
): { key: 'own' | 'sub'; tokens: number; tps: number }[] {
  if (!run.children && !run.helpers && tokenCount(run.sub) === 0) return []
  return [
    { key: 'own', tokens: tokenCount(run.own), tps: run.tps },
    { key: 'sub', tokens: tokenCount(run.sub), tps: run.subTps },
  ]
}

/** 缓存命中率：输入里命中缓存的比例 */
export const cacheRate = (task: Task) => cacheHitRate(task.usage)

/** 某个节点的执行情况：操作次数、改动文件数、当前在做什么、输出；deep 时包括开始、验收、结束等子节点 */
export function stepActivity(task: Task, id: string, deep = false) {
  const msgs = task.messages.filter(
    (m) => m.role === 'agent' && (m.step === id || (deep && m.step.startsWith(id + '/'))),
  )
  const tools = msgs.flatMap((m) => m.tools)
  const files = new Set(tools.filter((t) => t.kind === 'edit').map((t) => t.label))
  const last = msgs.at(-1)
  const text = msgs
    .map((m) => m.text)
    .filter(Boolean)
    .join('\n\n')
  return { msgs, tools: tools.length, files: files.size, last, lastTool: last?.tools.at(-1), text }
}

/** 没写动作名时按类型给的默认动作，参照 Claude Code 的 Read / Update / Bash / Search / Skill */
const VERB: Record<ToolUse['kind'], string> = {
  read: '读取',
  edit: '编辑',
  run: '运行',
  search: '搜索',
  web: '网页',
  skill: '技能',
  agent: '子任务',
  compact: '压缩上下文',
  other: '',
}

/** 显示用的默认动作名；VERB 保留中文原文，用来识别旧数据 label 里已经带的动作 */
const VERB_TEXT: Record<ToolUse['kind'], string> = {
  read: t('读取'),
  edit: t('编辑'),
  run: t('运行命令'),
  search: t('搜索'),
  web: t('网页'),
  skill: t('技能'),
  agent: t('子任务'),
  compact: t('压缩上下文'),
  other: '',
}

/** 工具调用的动作名；旧数据的 label 里已经带了动作（「搜索 xxx」「子任务：xxx」）就不再重复 */
export function toolVerb(tool: ToolUse) {
  const v = tool.name ?? VERB[tool.kind]
  if (!v || tool.label.startsWith(v) || /^(网页搜索|查找文件|子任务：)/.test(tool.label)) return ''
  return tool.name ?? VERB_TEXT[tool.kind]
}

/**
 * 面板自己的工具（panel MCP）调用名。各家 CLI 的写法不一样：
 * 「panel-xxxx · record_lesson」「panel_record_lesson」「mcp__panel-xxxx__record_lesson」，
 * 还有解析层归一后的「mcp__panel__record_lesson」（Pi 这类用扩展注册工具的 CLI 报的是裸名字）。
 */
const PANEL_TOOL = new RegExp(`panel[\\w-]*[\\W_]{1,4}(${PANEL_TOOL_NAMES.join('|')})\\b`)

/** 旧数据：Pi 报上来的 wait_agents 被记成了 CLI 自己的子 Agent（没有名字、没有标题），按它的输出认回来 */
const OLD_WAIT = /^(做完 \d+ 个|还在执行 \d+ 个|你还没有派出子任务)/

/** 面板工具的名字：认不出来时是空的 */
function panelName(tool: ToolUse) {
  const hit = PANEL_TOOL.exec(`${tool.name ?? ''} ${tool.label}`)
  if (hit) return hit[1]
  // 旧数据：带服务名前缀的后台命令被解析成了 CLI 自己的「运行命令」，按面板给的回复认回来
  if (tool.kind === 'run' && /已放到后台（编号 [0-9a-f]{8}）/.test(tool.output ?? '')) return 'run_background'
  return tool.kind === 'agent' && !tool.name && !tool.label && OLD_WAIT.test(tool.output ?? '') ? 'wait_agents' : ''
}

/** 别的 MCP 工具：解析器记成 name「MCP」、label「服务名 · 工具名」 */
const MCP_LABEL = /^(.+?) · (.+)$/

/** 工具调用的参数：多数 CLI 给的是 JSON，解析不了就当没有 */
function toolArgs(tool: ToolUse): Record<string, unknown> {
  try {
    const v = JSON.parse(tool.input ?? '')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const firstLine = (v: unknown) =>
  String(v ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? ''

/**
 * input 是命令原文而不是 JSON：解析层（server/exec/parsers.ts 的 inputText）对带 command 的参数
 * 直接存命令原文，面板的 run_background 因此拿不到 name / command 两个参数。
 * 和 toolArgs 同一个口径：只有解析成对象才说明是正常的参数；`true`、`false`、数字这些合法 JSON
 * 字面量是命令原文（`command: "true"` 是真实存在的 shell 命令），也要拿来当标题。
 */
function rawCommand(tool: ToolUse) {
  const raw = (tool.input ?? '').trim()
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? undefined : raw
  } catch {
    return raw
  }
}

/** 后台命令行上的名字：调用方给的名字，没有就用命令第一行（老记录、演示数据可能没有名字） */
export const jobLabel = (job: Pick<TaskJob, 'name' | 'command'>) =>
  firstLine(job.name) || firstLine(job.command) || t('后台命令')

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).join(t('、')) : '')

/** 一次工具调用在对话里怎么显示：tool 是改写后的调用，server 是别的 MCP 工具所在的服务（单独淡色标出） */
export interface ToolView {
  tool: ToolUse
  server?: string
  /** 新建、交给子对话的调用：点标题打开的子对话 id */
  child?: string
  /** 放到后台的命令：面板给的编号，命令还在跑时这一行一直转圈 */
  job?: string
  /** 申请的编译：面板排的几条后台命令（每个编译步骤一条），有一条还没跑完这一行就转圈 */
  jobs?: string[]
  /** 交出去的后台命令还有没拿到结果的：这一行一直转圈，不显示成完成（结果由面板接在输出后面） */
  waiting?: boolean
  /** 这次调用启动了一次工作流：点标题打开这次运行的对话，不是一段文本 */
  startsRun?: boolean
  /** 给另一个对话发消息（交给子对话、回报父对话、给其他父对话传话）：画成一行「发送消息」 */
  send?: { kind: PeerKind; to: string; body: string }
}

/** 几次交给子对话合成一行时的一个收件方：名字、能打开的子对话、面板给的回执、有没有送到 */
export interface SendTarget {
  name: string
  child?: string
  receipt?: string
  failed?: boolean
}

/** 给另一个对话发消息的几个工具：收件方是谁、哪一类、正文 */
function sendOf(name: string, tool: ToolUse): ToolView['send'] {
  const a = toolArgs(tool)
  const quoted = /「([^」]+)」/.exec(tool.output ?? '')?.[1] ?? ''
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  if (name === 'send_to_conversation')
    return { kind: 'task', to: quoted || firstLine(a.id) || t('子对话'), body: str(a.message) }
  if (name === 'message_peer') return { kind: 'chat', to: quoted || t('其他父对话'), body: str(a.text) }
  // 节点之间、给子任务传话：收件方在工具结果里（「已交给正在执行的「测试」」），没有就用参数里的 to
  if (name === 'send_message')
    return { kind: 'chat', to: quoted || firstLine(a.to) || t('其他节点'), body: str(a.text) }
  if (name === 'message_parent') {
    const opts = Array.isArray(a.options) ? a.options.map((x, i) => `${i + 1}. ${String(x)}`).join('\n') : ''
    return {
      kind: a.question ? 'question' : 'report',
      to: t('父对话'),
      body: [str(a.text), opts].filter(Boolean).join('\n\n'),
    }
  }
  return undefined
}

/**
 * 工具调用的显示：面板工具说做了什么（新建子对话 + 名字、开独立分支 + 分支名），别的 MCP 工具把工具名当动作、
 * 服务名淡色放在旁边，不再是一串「MCP 服务名 · 工具名」。返回 null 表示不用显示（派出的子任务另有自己的一行）
 */
export function toolView(tool: ToolUse): ToolView | null {
  const panel = panelTool(tool)
  if (panel === null) return null
  if (panel) {
    const name = panelName(tool)
    const child = panelChildId(tool)
    const ids = name === 'run_background' || name === 'request_build' ? bgJobIds(tool.output ?? '') : []
    const job = name === 'run_background' ? ids[0] : undefined
    const jobs = name === 'request_build' ? ids : undefined
    // 交出去的命令还没拿到结果：不管那一刻的调用记的是什么，这一行都算在跑
    const waiting = ids.length > 0 && bgPendingIds(tool.output ?? '').length > 0
    const startsRun = name === 'start_plan' || name === 'run_workflow'
    const send = sendOf(name, tool)
    return {
      tool: panel,
      ...(send && { send }),
      ...(child && { child }),
      ...(job && { job }),
      ...(jobs?.length && { jobs }),
      ...(waiting && { waiting }),
      ...(startsRun && { startsRun }),
    }
  }
  const mcp = tool.name === 'MCP' ? MCP_LABEL.exec(tool.label) : null
  if (!mcp) return { tool }
  const a = toolArgs(tool)
  const arg = Object.values(a).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  return { tool: { ...tool, name: mcp[2], label: arg ? firstLine(arg).slice(0, 120) : '' }, server: mcp[1] }
}

/**
 * 一条消息里的工具行，相邻几次「同一段话发给不同子对话」合成一组：以前父对话会把用户的一条要求逐个转给
 * 四五个子对话（现在面板拒绝这么发，见 shared/peer-message.ts 的 sentToOther），旧记录里只画一行「发送消息」，展开看每个收件人，不再刷出四五行一模一样的标题。
 * 返回的每组画成一行；只有一个工具的组照常画
 */
export function groupTools(tools: ToolUse[]): ToolUse[][] {
  const out: ToolUse[][] = []
  let key = ''
  for (const tool of tools) {
    const send = toolView(tool)?.send
    // 只合并交给子对话的：回报父对话、传话本来就只有一个收件方
    const k = send && send.body && panelName(tool) === 'send_to_conversation' ? `${send.kind}\n${send.body}` : ''
    if (k && k === key) out[out.length - 1].push(tool)
    else out.push([tool])
    key = k
  }
  return out
}

/**
 * 「启动工作流」这一行启动的是第几次运行：调用之后第一条属于运行节点的消息，那个节点的 runId 就是这次运行。
 * 工具调用没有自己的 id，只能按交给它的内容（input，跑完了再加上输出）认回同一次调用；
 * 认不回来（调用失败、还没开始执行）时返回 undefined，界面按「没有运行」显示原因
 */
export function startedRun(task: Task, tool: ToolUse): number | undefined {
  const input = (tool.input ?? '').trim()
  const output = (tool.output ?? '').trim()
  const call = (t: ToolUse) => {
    const v = toolView(t)
    if (!v?.startsRun) return false
    if ((v.tool.input ?? '').trim() !== input) return false
    // 输出认得出来时一并比：同一段要求在同一个对话里跑过两次，靠它分成两次
    const got = (v.tool.output ?? '').trim()
    return !output || !got || got === output
  }
  const at = task.messages.findIndex((m) => m.tools.some(call))
  if (at < 0) return undefined
  const runs = [...new Set(task.steps.map((s) => s.runId))].filter((r) => r >= 1).sort((a, b) => a - b)
  for (const m of task.messages.slice(at + 1)) {
    // 再往后又启动了一次工作流：那是另一件事，说明这一条没有跑起来
    if (m.tools.some((t) => toolView(t)?.startsRun)) return undefined
    if (!m.step) continue
    const run = runs.find((r) => topSteps(task, r).some((s) => m.step === s.id || m.step.startsWith(`${s.id}/`)))
    if (run !== undefined) return run
  }
  return undefined
}

/**
 * 面板工具在对话里怎么显示：说做了什么（新建子对话 + 子对话名字），不显示 MCP 服务名和原始工具名。
 * 展开时看的是正文（交给子对话的消息、回报的内容），不是一段 JSON。
 * 返回 undefined 表示不是面板工具，照常显示；null 表示不用显示（派出的子任务另有自己的一行）
 */
export function panelTool(tool: ToolUse): ToolUse | null | undefined {
  const name = panelName(tool)
  if (!name) return undefined
  const a = toolArgs(tool)
  const quoted = /「([^」]+)」/.exec(tool.output ?? '')?.[1] ?? ''
  const as = (name: string, label: string, kind: ToolUse['kind'] = 'other', input?: string): ToolUse => ({
    ...tool,
    kind,
    name,
    label,
    ...(input !== undefined && { input }),
  })
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  switch (name) {
    case 'create_conversation':
      return as(t('新建子对话'), firstLine(a.title) || quoted, 'agent', text(a.message))
    case 'send_to_conversation':
      return as(t('发送消息'), quoted || firstLine(a.id), 'agent', text(a.message))
    case 'list_conversations':
      return as(t('查看子对话'), '')
    // 成功派出时子任务各有一行（转圈、完成、失败），这次调用不再单独显示；失败了要让人看到原因
    case 'spawn_agents':
      return tool.failed ? as(t('派出子任务'), '', 'agent') : null
    // 等子任务是在等面板派出的那几个，不是 CLI 自己的子 Agent：标题写清楚等了几个、做完几个
    case 'wait_agents':
      return as(t('等待子任务'), waitSummary(tool, a), 'agent')
    // 终止自己派出的子任务：标题写终止的原因，展开看终止了哪几个
    case 'stop_subtask':
      return as(t('终止子任务'), firstLine(a.reason), 'agent', tool.output || undefined)
    case 'run_background': {
      // input 可能直接是命令原文（见 rawCommand）：参数解析拿不到 name / command，
      // 标题用命令第一行，展开的 IN 用完整命令，不能只剩「后台命令」一行
      const command = text(a.command) ?? rawCommand(tool) ?? (tool.kind === 'run' ? tool.label : undefined)
      return as(t('后台命令'), firstLine(a.name) || firstLine(command), 'other', command)
    }
    case 'check_background':
      return as(t('查看后台命令'), firstLine(a.id))
    case 'stop_background':
      return as(t('停止后台命令'), firstLine(a.id))
    case 'message_parent': {
      const opts = Array.isArray(a.options) ? a.options.map((x, i) => `${i + 1}. ${String(x)}`).join('\n') : ''
      const body = [text(a.text), opts].filter(Boolean).join('\n\n')
      return as(t('发送消息'), firstLine(a.text), 'other', body || undefined)
    }
    case 'suggest_next_step': {
      const opts = Array.isArray(a.options) ? a.options.map((x, i) => `${i + 1}. ${String(x)}`).join('\n') : ''
      const body = [text(a.text), opts].filter(Boolean).join('\n\n')
      return as(t('收尾建议交给用户选'), firstLine(a.text), 'other', body || undefined)
    }
    case 'submit_merge':
    case 'submit_build':
      return as(t('请父对话收尾'), firstLine(a.note), 'other', text(a.tests))
    // 父对话收尾子对话：标题写子对话的名字（结果里有），点它打开那个子对话
    case 'finish_child':
      return as(t('收尾子对话'), quoted || firstLine(a.id), 'agent')
    case 'request_build':
      return as(t('申请编译'), firstLine(a.note), 'other', text(a.note))
    case 'list_peers':
      return as(t('查看其他父对话'), '')
    case 'message_peer':
      return as(t('发送消息'), firstLine(a.text), 'other', text(a.text))
    case 'start_plan':
    case 'run_workflow':
      return as(t('启动工作流'), firstLine(a.input), 'other', text(a.input))
    case 'set_plan': {
      const n = Array.isArray(a.steps) ? a.steps.length : 0
      // 展开看合并后的计划（工具结果里有），不看一段 JSON
      return as(t('更新计划'), firstLine(a.title) || (n ? t('{n} 个步骤', { n }) : ''), 'other', '')
    }
    case 'finish_plan':
      return as(t('结束计划'), '')
    case 'close_run':
      return as(t('结束这次运行'), '')
    case 'get_status':
      return as(t('查看节点状态'), '')
    case 'begin_edit': {
      // 开出来的分支名在结果里：「已开独立分支 xxx（目录 …）」「已经在独立分支 xxx 里」
      const branch = /独立分支 (\S+?)(?:（| 里|$)/.exec(tool.output ?? '')?.[1] ?? ''
      return as(t('开独立分支'), branch)
    }
    case 'claim_files':
      return as(t('认领文件'), list(a.paths))
    case 'release_files':
      return as(t('释放文件'), list(a.paths))
    case 'p4_split_changelists':
      return as(t('按类型分 changelist'), a.from ? `#${firstLine(a.from)}` : 'default', 'other', '')
    case 'record_lesson':
      return as(a.id ? t('改写教训') : t('记下教训'), firstLine(a.title), 'other', text(a.rule))
    case 'project_lessons':
      return as(t('查看项目教训'), list(a.files), 'read')
    case 'read_state':
      return as(t('读取共享状态'), '')
    case 'write_state':
      return as(t('写入共享状态'), firstLine(a.key), 'other', text(a.value))
    case 'ask_main':
      return as(t('向主角色提问'), firstLine(a.question), 'other', text(a.question))
    case 'send_message':
      return as(t('发送消息'), quoted || firstLine(a.to), 'other', text(a.text))
    case 'read_messages':
      return as(t('查看消息'), '')
    case 'read_user_notes':
      return as(t('查看用户补充'), '', 'read')
    // 提问和等下一句：问题本身有提问卡片，这里只说明模型在做什么
    case 'ask_user':
      return as(
        t('向用户提问'),
        firstLine(a.question) || firstLine((a.questions as { question?: unknown }[] | undefined)?.[0]?.question),
        'other',
      )
    case 'wait_user_message':
      return as(t('等待用户消息'), '')
    // 操控软件：标题写动作名，展开看参数和结果
    case 'app_actions':
      return as(t('查看软件操作'), firstLine(a.group), 'read')
    case 'app_do':
      return as(
        t('操作软件'),
        firstLine(a.action),
        'other',
        a.args && typeof a.args === 'object' && Object.keys(a.args).length ? JSON.stringify(a.args, null, 2) : '',
      )
  }
  return undefined
}

/** 等待子任务这一行的标题：等完了说做完几个、还剩几个，没等完说在等几个 */
function waitSummary(tool: ToolUse, a: Record<string, unknown>) {
  const out = tool.output ?? ''
  const done = Number(/做完 (\d+) 个/.exec(out)?.[1] ?? 0)
  const left = Number(/还在执行 (\d+) 个/.exec(out)?.[1] ?? 0)
  if (done || left) return left ? t('做完 {done} 个，还剩 {left} 个', { done, left }) : t('{n} 个都做完了', { n: done })
  if (/你还没有派出子任务/.test(out)) return t('没有派出的子任务')
  const ids = Array.isArray(a.ids) ? a.ids.length : 0
  return ids ? t('{n} 个', { n: ids }) : t('全部')
}

/** 新建子对话、交给子对话这两次调用指向哪个子对话：新建的 id 在工具输出的「（id: …）」里，交给的在参数里 */
export function panelChildId(tool: ToolUse) {
  const name = panelName(tool)
  if (name === 'create_conversation') return /（id: ([^）\s]+)）/.exec(tool.output ?? '')?.[1] ?? ''
  if (name === 'send_to_conversation' || name === 'finish_child') return firstLine(toolArgs(tool).id)
  return ''
}

/** 「正在做什么」的一句话 */
export function currentActivity(a: ReturnType<typeof stepActivity>) {
  if (a.last?.text.trim()) return t('正在输出：{text}', { text: plainLine(a.last.text, true) })
  if (a.lastTool) {
    const v = toolView(a.lastTool)?.tool ?? a.lastTool
    return `${toolVerb(v)} ${v.label}`.trim()
  }
  // 开着思考的模型先想很久才出正文，这时显示想到哪了，免得一直停在「正在启动」
  const thinking = a.last?.thinking ? plainLine(a.last.thinking, true) : ''
  if (thinking) return t('正在思考：{text}', { text: thinking })
  if (a.last) return t('正在思考…')
  return t('正在启动 Agent…')
}

/** 去掉 Markdown 记号后的第一行（last = 取最后一行） */
export function plainLine(text: string, last = false) {
  const lines = text
    .split('\n')
    .map((l) =>
      l
        .replace(/^[#>*\-\d.\s]+/, '')
        .replace(/[*`_]/g, '')
        .trim(),
    )
    .filter(Boolean)
  return (last ? lines.at(-1) : lines[0]) ?? ''
}

/** 耗时：实现在 shared/duration（界面、报告、后台命令文案共用同一处），这里只转出去 */
export { fmtDuration }

export function stepDuration(
  step: { startedAt: string; endedAt: string; status: string; spentMs?: number },
  now: number,
) {
  const ms = stepMs(step, now)
  return ms >= 1000 ? fmtDuration(ms) : ''
}

/** 时刻：今天的只写时分秒，其他日子带上日期 */
export function fmtClock(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  const locale = getLang() === 'en' ? 'en-US' : 'zh-CN'
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`
}

/** 子节点的说明：「验收 第 2 轮 · 审查改动」 */
export function stepLabel(s: TaskStep) {
  if (!s.parentId || s.kind === 'main') return s.title
  return `${SLOT_LABEL[s.slot] ?? ''}${s.round ? t(' 第 {n} 轮', { n: s.round }) : ''} · ${s.title}`
}

/** 节点在第几层：主流程节点是 0 */
export const stepDepth = (s: TaskStep) => (s.id.split('/').length - 1) / 2

/** 验收情况：「验收 2 轮 · 通过」 */
export function verdictText(s: TaskStep) {
  // 主 Agent 的 rounds 是调度轮数，不是验收
  if (!s.rounds || s.kind === 'main') return ''
  return s.verdict === 'fail' ? t('验收 {n} 轮 · 未通过', { n: s.rounds }) : t('验收 {n} 轮 · 通过', { n: s.rounds })
}

/**
 * 服务端这次返回（或推送）的对话里有没有这条消息：没有的话页面要撤掉本地那条「待认领」。
 * 面板自己处理的命令（/rule 发布全局规则）只回一条 system 提示，不把用户这条记进对话
 */
export const messageRecorded = (messages: Pick<TaskMessage, 'id'>[], messageId: string) =>
  messages.some((m) => m.id === messageId)

/**
 * 请求报错时这条消息其实已经交给 CLI 了吗：服务端记下了、又不是「没送出去」，
 * 就不能把原文再放回输入框（否则会出现「消息发出去了、输入框里字还在」）。
 * 没记下、没有交付记录、或者还停在页面本地的 pending，都返回 false，页面才把原文放回输入框
 */
export const deliveredToCli = (m: Pick<TaskMessage, 'delivery'> | undefined) =>
  !!m?.delivery && m.delivery.how !== 'lost' && m.delivery.how !== 'pending'

/**
 * 执行中的状态行要不要显示「排队等 API 名额」：要显示时返回那个标记，否则 undefined。
 *
 * 只在「这一轮还没开始、正在排队等名额」时显示（reason 是 'start'）：
 * 让出名额等子任务 / 等下一句之后拿回的排队（'yield'）属于「交回结果的那一句」，
 * 这一轮其实仍在输出，写成排队会和同一行右边的实时速度自相矛盾。
 * 已经在出 token 时也不显示排队：两套数据打架时以「真的在输出」为准。
 */
export function apiQueueWait(task: Pick<Task, 'apiWait'>, streaming: boolean) {
  const wait = task.apiWait
  if (!wait || wait.reason !== 'start' || streaming) return undefined
  return wait
}
