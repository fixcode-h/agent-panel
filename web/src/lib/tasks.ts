import type { Task, TaskStatus, TaskStep, ToolUse } from '@shared/schema'
import { SLOT_LABEL } from '@shared/flow'
import { getLang, t } from '@shared/i18n'
import { stepMs } from '@shared/task'
import { cacheHitRate } from '@shared/task-export'
import { tokenCount, type RunUsage } from '@shared/run-usage'
import { PANEL_TOOL_NAMES } from '@shared/panel-tools'

export const statusLabel: Record<TaskStatus, string> = {
  running: t('执行中'),
  done: t('已完成'),
  stopped: t('已暂停'),
  failed: t('失败'),
}

/** 「3 分钟前」这类相对时间 */
export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) })
  if (s < 86400 * 30) return t('{n} 天前', { n: Math.floor(s / 86400) })
  return new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'zh-CN')
}

export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

/**
 * 实时速度：正在输出的 Agent 的 token/s 之和（工作流里可能几个节点同时输出）。
 * 没有输出时显示这一轮最后一次的速度；刚开始还没有输出时为 0。实现和「整个运行」的统计共用一个（shared/run-usage）。
 */
export { liveTps } from '@shared/run-usage'

/**
 * Token 浮层里的分组：有子对话或派出的子任务时才分开列「本对话」「子任务与子对话」，
 * 没有时返回空数组，浮层退化成只显示总数和输入输出（不出现「子任务 0」这种噪音行）。
 * 子任务的速度 = 整个运行的速度 − 本对话的速度，两项加起来正好是整体。
 */
export function tokenGroups(
  run: Pick<RunUsage, 'own' | 'sub' | 'tps' | 'runTps' | 'children' | 'helpers'>,
): { key: 'own' | 'sub'; tokens: number; tps: number }[] {
  if (!run.children && !run.helpers && tokenCount(run.sub) === 0) return []
  return [
    { key: 'own', tokens: tokenCount(run.own), tps: run.tps },
    { key: 'sub', tokens: tokenCount(run.sub), tps: Math.max(0, run.runTps - run.tps) },
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

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).join(t('、')) : '')

/** 一次工具调用在对话里怎么显示：tool 是改写后的调用，server 是别的 MCP 工具所在的服务（单独淡色标出） */
export interface ToolView {
  tool: ToolUse
  server?: string
  /** 新建、交给子对话的调用：点标题打开的子对话 id */
  child?: string
}

/**
 * 工具调用的显示：面板工具说做了什么（新建子对话 + 名字、开独立分支 + 分支名），别的 MCP 工具把工具名当动作、
 * 服务名淡色放在旁边，不再是一串「MCP 服务名 · 工具名」。返回 null 表示不用显示（派出的子任务另有自己的一行）
 */
export function toolView(tool: ToolUse): ToolView | null {
  const panel = panelTool(tool)
  if (panel === null) return null
  if (panel) {
    const child = panelChildId(tool)
    return { tool: panel, ...(child && { child }) }
  }
  const mcp = tool.name === 'MCP' ? MCP_LABEL.exec(tool.label) : null
  if (!mcp) return { tool }
  const a = toolArgs(tool)
  const arg = Object.values(a).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  return { tool: { ...tool, name: mcp[2], label: arg ? firstLine(arg).slice(0, 120) : '' }, server: mcp[1] }
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
      return as(t('交给子对话'), quoted || firstLine(a.id), 'agent', text(a.message))
    case 'list_conversations':
      return as(t('查看子对话'), '')
    // 成功派出时子任务各有一行（转圈、完成、失败），这次调用不再单独显示；失败了要让人看到原因
    case 'spawn_agents':
      return tool.failed ? as(t('派出子任务'), '', 'agent') : null
    // 等子任务是在等面板派出的那几个，不是 CLI 自己的子 Agent：标题写清楚等了几个、做完几个
    case 'wait_agents':
      return as(t('等待子任务'), waitSummary(tool, a), 'agent')
    case 'run_background':
      return as(t('后台命令'), firstLine(a.name) || firstLine(a.command), 'other', text(a.command))
    case 'check_background':
      return as(t('查看后台命令'), firstLine(a.id))
    case 'message_parent': {
      const opts = Array.isArray(a.options) ? a.options.map((x, i) => `${i + 1}. ${String(x)}`).join('\n') : ''
      const body = [text(a.text), opts].filter(Boolean).join('\n\n')
      return as(a.question ? t('请父对话决定') : t('回报父对话'), firstLine(a.text), 'other', body || undefined)
    }
    case 'submit_merge':
    case 'submit_build':
      return as(t('合回原分支'), firstLine(a.note))
    case 'start_plan':
    case 'run_workflow':
      return as(t('启动工作流'), firstLine(a.input), 'other', text(a.input))
    case 'set_plan': {
      const n = Array.isArray(a.steps) ? a.steps.length : 0
      // 展开看合并后的计划（工具结果里有），不看一段 JSON
      return as(t('更新计划'), firstLine(a.title) || (n ? t('{n} 个步骤', { n }) : ''), 'other', '')
    }
    case 'finish_plan':
      return as(t('计划总结'), firstLine(a.summary), 'other', text(a.summary))
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
      return as(t('传话'), [firstLine(a.to), firstLine(a.text)].filter(Boolean).join(' · '), 'other', text(a.text))
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
  if (name === 'send_to_conversation') return firstLine(toolArgs(tool).id)
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

/** 一次操作的耗时：秒，保留两位小数，例如 1.23s */
export function fmtSecs(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t('{s} 秒', { s })
  if (s < 3600) return t('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
  return t('{h} 小时 {m} 分', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) })
}

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
