/**
 * 对话视图里工作流节点卡片要显示的摘要（方案 A「节点分段」，用户 2026-11-27 定）：
 * 一句结论、产出（改了哪些文件、交了几版阶段报告）、在跑节点最近几次工具调用和最新一句话。
 * 只是挑出来给人看的文字，节点做没做完、通没通过仍然只看节点状态和 submit_* 交的结果
 */
import type { FileChange, Task, TaskMessage, TaskStep, ToolUse } from '@shared/schema'
import { stepTree } from '@shared/flow'
import { plainText } from '@shared/summary/render'
import { toolView } from '@/lib/tasks'

/** 摘要最多多少字：卡片里一行半，再长就截断（完整的点开节点看） */
const SUMMARY_MAX = 160

/** 属于这个节点（含验收、子流程等下层节点）的消息 */
export function stepMessages(task: Pick<Task, 'messages'>, rootId: string): TaskMessage[] {
  return task.messages.filter((m) => m.step === rootId || m.step.startsWith(`${rootId}/`))
}

/** Markdown 的第一段：去掉标题、列表、引用的记号，压成一行 */
function firstParagraph(md: string) {
  const para =
    md
      .replace(/```[\s\S]*?```/g, '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^[-=*_]{3,}$/.test(p)) ?? ''
  return plainText(para.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s?|\d+[.)]\s+)/gm, ''))
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** Agent 最近说的一句话：最后一条有正文的回复的最后一段（在跑节点显示「现在在干什么」） */
export function latestText(msgs: TaskMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'agent' || !m.text.trim()) continue
    const paras = m.text
      .replace(/```[\s\S]*?```/g, '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
    const last = paras.at(-1)
    if (last) return clip(firstParagraph(last), SUMMARY_MAX)
  }
  return ''
}

/**
 * 节点的一句话结论：先用 submit_result 交的总结，没交就用节点的最终输出（交给下游的那份），
 * 再没有用 Agent 最后一句话。没做完时 left（还差什么）比总结更有用
 */
export function stepSummary(step: TaskStep, msgs: TaskMessage[]): string {
  const sub = step.submitted
  if (step.status === 'failed' && sub?.left.trim()) return clip(plainText(sub.left), SUMMARY_MAX)
  if (sub?.summary.trim()) return clip(firstParagraph(sub.summary), SUMMARY_MAX)
  if (step.output.trim()) return clip(firstParagraph(step.output), SUMMARY_MAX)
  return latestText(msgs)
}

/** 在跑节点最近的几次工具调用（面板内部、不显示的调用不算） */
export function liveTools(msgs: TaskMessage[], n = 3): ToolUse[] {
  const tools = msgs.filter((m) => m.role === 'agent').flatMap((m) => m.tools)
  return tools.filter((x) => toolView(x) !== null).slice(-n)
}

/** 节点（含下层节点）改过的文件：同一个文件只算一次，增删行数相加 */
export function stepFiles(task: Pick<Task, 'steps'>, root: TaskStep): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const s of [root, ...stepTree(task, root.id)])
    for (const c of s.changes) {
      const had = byPath.get(c.path)
      byPath.set(c.path, had ? { ...had, add: had.add + c.add, del: had.del + c.del } : { ...c })
    }
  return [...byPath.values()]
}

/** 节点（含下层节点）交过几版阶段报告 */
export function stepReportCount(task: Pick<Task, 'steps'>, root: TaskStep): number {
  return [root, ...stepTree(task, root.id)].reduce((n, s) => n + (s.submitted?.reports?.length ?? 0), 0)
}
