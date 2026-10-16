import type { Agent, Task, TaskStatus, Workflow } from '@shared/schema'

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
const TOOL_TOKENS = { read: 1800, search: 600, run: 900, edit: 400, other: 300 } as const

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

export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
