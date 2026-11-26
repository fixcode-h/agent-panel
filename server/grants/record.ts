/**
 * 面板替用户放行一次调用时在对话里留的记录（自动允许的也要看得见，不悄悄放过）：
 * 照旧记一条系统消息（带结构化的 grant，导出、旧版页面照样读得到文案），再把放行小标挂到这次调用的工具卡片上（ToolUse.grant），
 * 对话页看到卡片挂上了就不再单独显示那一行（shared/grants/notes.ts，用户 2026-11-26 选的方案 A）。
 * 面板执行放行时拿不到工具行的编号，按工具类型、命令原文、工具名在最近几条回复里认（和 capability-router/tag-route.ts 同一个办法）；
 * 认不出的那条留在对话里，由页面把连续的合成一行
 */
import type { NoteGrant, Task, TaskMessage, ToolUse } from '../../shared/schema.ts'

/** 怎么认这次调用的工具行 */
export interface GrantMatch {
  /** 工具行的类型 */
  kinds: ToolUse['kind'][]
  /** 工具行的输入或标题里要有的一段（命令开头、文件名）；空时不比 */
  needle?: string
  /** 工具行标题要对上（面板工具 custom_tool、插件工具的服务名） */
  label?: RegExp
  /** 只认还在执行的（MCP 工具请确认时那次调用一定还没结束） */
  running?: boolean
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 命令原文取开头一段来认：工具行的标题可能是截短的命令 */
export const commandNeedle = (cmd: string) => squash(cmd).slice(0, 40)

function rowOf(task: Pick<Task, 'messages'>, step: string, match: GrantMatch): ToolUse | undefined {
  let seenAgent = 0
  for (let i = task.messages.length - 1; i >= 0 && seenAgent < 3; i--) {
    const m = task.messages[i]
    if (m.role !== 'agent' || (m.step || '') !== (step || '')) continue
    seenAgent++
    for (let j = m.tools.length - 1; j >= 0; j--) {
      const t = m.tools[j]
      if (t.grant || !match.kinds.includes(t.kind)) continue
      if (match.running && !t.running) continue
      if (match.label && !match.label.test(t.label)) continue
      if (match.needle) {
        const hay = squash(`${t.input ?? ''}\n${t.label}`)
        const label = squash(t.label)
        if (!hay.includes(match.needle) && !(label.length >= 8 && match.needle.includes(label.slice(0, 40)))) continue
      }
      return t
    }
  }
  return undefined
}

/** 挂上了返回 true */
export function tagGrant(task: Pick<Task, 'messages'>, note: TaskMessage, match: GrantMatch): boolean {
  if (!note.grant) return false
  const row = rowOf(task, note.step, match)
  if (!row) return false
  row.grant = { via: note.grant.via, label: note.grant.label, note: note.id }
  return true
}

export interface GrantCtx {
  task: Task
  newId: () => string
  changed: (flush?: boolean) => void
}

/**
 * 记一条放行：系统消息照旧进对话，能认出工具行就挂上小标。工具行通常已经在了（CLI 先报 tool_use 再请求权限）；
 * 个别 CLI 晚一点才报时等一下再认一次，还认不出就算了：那一行留在对话里由页面合并显示
 */
export function recordGrant(
  ctx: GrantCtx,
  o: { agentId: string; step: string; text: string; grant: NoteGrant; match?: GrantMatch; id?: string },
  retryMs = 1500,
): TaskMessage {
  const note: TaskMessage = {
    id: o.id ?? ctx.newId(),
    role: 'system',
    agentId: o.agentId,
    step: o.step,
    text: o.text,
    tools: [],
    at: new Date().toISOString(),
    grant: o.grant,
  }
  ctx.task.messages.push(note)
  const match = o.match
  if (match && !tagGrant(ctx.task, note, match))
    setTimeout(() => tagGrant(ctx.task, note, match) && ctx.changed(), retryMs).unref?.()
  ctx.changed()
  return note
}
