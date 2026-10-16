import type { Agent, Task, TaskStatus, TaskStep, ToolUse, Workflow } from '@shared/schema'
import { SLOT_LABEL } from '@shared/flow'

export const statusLabel: Record<TaskStatus, string> = {
  running: '执行中',
  done: '已完成',
  stopped: '已停止',
  failed: '失败',
}

/** 「3 分钟前」这类相对时间 */
export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

/** 粗略估算 token：中日韩字符约 1 个，其他字符约 4 个一个 */
export function estimateTokens(text: string) {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/** 每次读文件、跑命令带回的内容，按经验值估算 */
const TOOL_TOKENS: Record<ToolUse['kind'], number> = {
  read: 1800,
  search: 600,
  run: 900,
  edit: 400,
  web: 1500,
  skill: 1200,
  agent: 800,
  other: 300,
}

export interface ContextPart {
  key: string
  label: string
  tokens: number
  color: string
}

/** 上下文占用估算。真实执行接入后改为读取 CLI 返回的用量 */
export function contextUsage(task: Task, workflow: Workflow | undefined, agents: Agent[]) {
  const team = task.mode === 'chat' ? [task.agentId] : [...new Set(task.steps.map((s) => s.agentId))]
  const byId = new Map(agents.map((a) => [a.id, a]))
  const parts: ContextPart[] = [
    { key: 'doc', label: '工作流文档', tokens: estimateTokens(workflow?.document ?? ''), color: 'var(--accent)' },
    {
      key: 'role',
      label: '角色设定',
      tokens: team.reduce((n, id) => n + estimateTokens(byId.get(id)?.instructions ?? ''), 0),
      color: '#3b82f6',
    },
    {
      key: 'msg',
      label: '对话消息',
      tokens: task.messages.reduce((n, m) => n + estimateTokens(m.text), 0),
      color: '#10b981',
    },
    {
      key: 'tool',
      label: '工具结果',
      tokens: task.messages.reduce((n, m) => n + m.tools.reduce((k, t) => k + TOOL_TOKENS[t.kind], 0), 0),
      color: '#f59e0b',
    },
  ]
  const used = parts.reduce((n, p) => n + p.tokens, 0)
  return { parts, used, window: 200_000 }
}

export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))

/** 实时速度：正在输出的 Agent 的 token/s 之和（工作流里可能几个节点同时输出） */
export function liveTps(task: Task, agentIds?: string[]) {
  return Object.entries(task.usage.agents)
    .filter(([id]) => !agentIds || agentIds.includes(id))
    .reduce((n, [, u]) => n + (u.tps ?? 0), 0)
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
  other: '',
}

/** 工具调用的动作名；旧数据的 label 里已经带了动作（「搜索 xxx」「子任务：xxx」）就不再重复 */
export function toolVerb(tool: ToolUse) {
  const v = tool.name ?? VERB[tool.kind]
  if (!v || tool.label.startsWith(v) || /^(网页搜索|查找文件|子任务：)/.test(tool.label)) return ''
  return v
}

/** 「正在做什么」的一句话 */
export function currentActivity(a: ReturnType<typeof stepActivity>) {
  if (a.last?.text.trim()) return `正在输出：${plainLine(a.last.text, true)}`
  if (a.lastTool) return `${toolVerb(a.lastTool)} ${a.lastTool.label}`.trim()
  return '正在启动 CLI…'
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
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
}

export function stepDuration(step: { startedAt: string; endedAt: string; status: string }, now: number) {
  if (!step.startedAt) return ''
  const end = step.endedAt ? new Date(step.endedAt).getTime() : step.status === 'running' ? now : 0
  const ms = end - new Date(step.startedAt).getTime()
  return end && ms >= 1000 ? fmtDuration(ms) : ''
}

/** 子节点的说明：「验收 第 2 轮 · 审查改动」 */
export function stepLabel(s: TaskStep) {
  if (!s.parentId) return s.title
  return `${SLOT_LABEL[s.slot] ?? ''}${s.round ? ` 第 ${s.round} 轮` : ''} · ${s.title}`
}

/** 节点在第几层：主流程节点是 0 */
export const stepDepth = (s: TaskStep) => (s.id.split('/').length - 1) / 2

/** 验收情况：「验收 2 轮 · 通过」 */
export function verdictText(s: TaskStep) {
  if (!s.rounds) return ''
  return `验收 ${s.rounds} 轮 · ${s.verdict === 'fail' ? '未通过' : '通过'}`
}
