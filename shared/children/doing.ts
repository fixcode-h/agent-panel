/**
 * 父对话里子对话那一行的补充信息：最后一次工具调用（分析稿 U5）、Bug 走到第几步（U8）。
 *
 * 最后一次工具调用：
 * 原来行上执行中写的是回复开头截的一段（「我先看了相关代码。真实执行时…」），没信息量；
 * 改成「计划当前那一步 · 最后一次工具调用（改 store.ts、跑 npm test）」。
 * childActivity（shared/task.ts）只在正在调用、或这一段还没说话时给 tool，开口说话后就换成了那句话，
 * 所以最后一次工具调用单独取一份。只看工具调用记录，不看回复文字（ADR 0041）
 */
import { bugStep } from '../bug/overview.ts'
import type { Task, ToolUse } from '../schema.ts'

export type LastTool = Pick<ToolUse, 'kind' | 'name' | 'label'>

/** 往回最多翻这么多条消息：很久以前的调用已经说明不了「这会儿在做什么」 */
const LOOK_BACK = 6

/**
 * 子对话自己（不算工作流节点 step 里的）最近一次工具调用；压缩上下文不算「在做的事」。
 * 用户发过新的一句之后，再往前的调用属于上一件事，不再拿来说
 */
export function lastToolCall(tk: Pick<Task, 'messages'>): LastTool | undefined {
  const msgs = tk.messages
  for (let i = msgs.length - 1, seen = 0; i >= 0 && seen < LOOK_BACK; i--, seen++) {
    const m = msgs[i]
    if (m.role === 'user') return undefined
    if (m.role !== 'agent' || m.step) continue
    const tool = [...(m.tools ?? [])].reverse().find((x) => x.kind !== 'compact' && x.label.trim())
    if (tool) return { kind: tool.kind, name: tool.name, label: tool.label.slice(0, 200) }
  }
  return undefined
}

/**
 * Bug 子对话走到五步（论证 / 根因 / 修复方案 / 修复 / 验证）的第几步（分析稿 U8）：父对话那一行直接画五个点，
 * 不用打开报告弹窗才知道。和总览的 Bug 视图同一个算法（bug-overview.ts 的 bugStep）；不是 Bug 时没有
 */
export function childBugStep(tk: Pick<Task, 'bug'>): number | undefined {
  return tk.bug?.kind === 'report' ? bugStep(tk.bug?.diagnoses ?? []) : undefined
}
