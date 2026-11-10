/**
 * 用户报的 Bug 交给 CLI 的方法文字（ADR 0046）：
 * - 用户发 /bug：按在哪发展开成不同的要求（父对话派 kind: "bug" 子对话；子对话就地按完整流程、交诊断报告；
 *   别的会话就地查到修复设计、在回复里给报告）。Claude Code 不认 /bug（它的同名命令是给 Anthropic 报问题），面板先展开。
 * - `kind: "bug"` 的子对话（Task.bug）：新会话第一轮带上完整查找流程。平时的角色设定只带简易版，不让每个对话都背着它
 */
import type { Task } from '../../shared/schema.ts'
import { BUG_CMD, BUG_FULL_TEXT, bugCommandPrompt } from '../../shared/builtin/bug-method.ts'

/** /bug 展开后的要求；不是 /bug 返回 undefined。coordinator：这个对话能开子对话（项目父对话） */
export function bugSlash(prompt: string, task: Pick<Task, 'parentTaskId'>, coordinator: boolean) {
  const text = prompt.trim()
  if (!BUG_CMD.test(text)) return undefined
  const where = coordinator ? 'coordinator' : task.parentTaskId ? 'child' : 'solo'
  return bugCommandPrompt(where, text.replace(BUG_CMD, ''))
}

/**
 * 要追加的完整流程：用户报的 Bug 才有。新会话第一轮带；父对话刚把它升级成 Bug（bugMethodPending，ADR 0057）时
 * 续接的会话里也补带一次。这一轮本身是 /bug 时展开里已经带了，不重复
 */
export function bugMethodPrompt(task: Pick<Task, 'bug' | 'bugMethodPending'>, prompt: string, firstTurn: boolean) {
  return (firstTurn || task.bugMethodPending) && task.bug && !BUG_CMD.test(prompt.trim()) ? BUG_FULL_TEXT : ''
}
