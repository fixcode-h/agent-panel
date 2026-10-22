import type { Task, TaskStatus, TaskStep, ToolUse } from '@shared/schema'
import { SLOT_LABEL } from '@shared/flow'
import { getLang, t } from '@shared/i18n'
import { stepMs } from '@shared/task'

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
 * 没有输出时显示这一轮最后一次的速度；刚开始还没有输出时为 0
 */
export function liveTps(task: Task, agentIds?: string[]) {
  const list = Object.entries(task.usage.agents).filter(([id]) => !agentIds || agentIds.includes(id))
  const live = list.reduce((n, [, u]) => n + (u.tps ?? 0), 0)
  if (live > 0) return live
  return list.reduce((n, [, u]) => n + (u.lastTps ?? 0), 0)
}

/** 缓存命中率：输入里命中缓存的比例 */
export const cacheRate = (task: Task) =>
  task.usage.inputTokens > 0 ? (task.usage.cacheReadTokens ?? 0) / task.usage.inputTokens : 0

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

/** 面板自己的工具（panel MCP）调用名：各家 CLI 显示成「panel-xxxx · create_conversation」「panel_create_conversation」等 */
const PANEL_TOOL =
  /panel[\w-]*\W{1,4}(create_conversation|send_to_conversation|list_conversations|spawn_agents|wait_agents|run_background|check_background|message_parent|submit_build|start_plan)\b/

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
 * 面板工具在对话里怎么显示：说做了什么（新建子对话 + 子对话名字），不显示 MCP 服务名和原始工具名。
 * 返回 undefined 表示不是面板工具，照常显示；null 表示不用显示（派出的子任务另有自己的一行）
 */
export function panelTool(tool: ToolUse): ToolUse | null | undefined {
  const hit = PANEL_TOOL.exec(`${tool.name ?? ''} ${tool.label}`)
  if (!hit) return undefined
  const a = toolArgs(tool)
  const quoted = /「([^」]+)」/.exec(tool.output ?? '')?.[1] ?? ''
  const as = (name: string, label: string, kind: ToolUse['kind'] = 'other'): ToolUse => ({
    ...tool,
    kind,
    name,
    label,
  })
  switch (hit[1]) {
    case 'create_conversation':
      return as(t('新建子对话'), firstLine(a.title) || quoted, 'agent')
    case 'send_to_conversation':
      return as(t('交给子对话'), quoted || firstLine(a.id), 'agent')
    case 'list_conversations':
      return as(t('查看子对话'), '')
    // 成功派出时子任务各有一行（转圈、完成、失败），这次调用不再单独显示；失败了要让人看到原因
    case 'spawn_agents':
      return tool.failed ? as(t('派出子任务'), '', 'agent') : null
    case 'wait_agents':
      return as(t('等待子任务'), '', 'agent')
    case 'run_background':
      return as(t('后台命令'), firstLine(a.name) || firstLine(a.command))
    case 'check_background':
      return as(t('查看后台命令'), firstLine(a.id))
    case 'message_parent':
      return as(a.question ? t('请父对话决定') : t('回报父对话'), firstLine(a.text))
    case 'submit_build':
      return as(t('提交编译'), firstLine(a.note))
    case 'start_plan':
      return as(t('启动工作流'), firstLine(a.input))
  }
  return undefined
}

/** 新建子对话、交给子对话这两次调用指向哪个子对话：新建的 id 在工具输出的「（id: …）」里，交给的在参数里 */
export function panelChildId(tool: ToolUse) {
  const hit = PANEL_TOOL.exec(`${tool.name ?? ''} ${tool.label}`)
  if (hit?.[1] === 'create_conversation') return /（id: ([^）\s]+)）/.exec(tool.output ?? '')?.[1] ?? ''
  if (hit?.[1] === 'send_to_conversation') return firstLine(toolArgs(tool).id)
  return ''
}

/** 「正在做什么」的一句话 */
export function currentActivity(a: ReturnType<typeof stepActivity>) {
  if (a.last?.text.trim()) return t('正在输出：{text}', { text: plainLine(a.last.text, true) })
  if (a.lastTool) return `${toolVerb(a.lastTool)} ${a.lastTool.label}`.trim()
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
