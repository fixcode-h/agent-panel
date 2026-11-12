/**
 * 有项目的普通对话里发 /bug（分析稿 B10）：以前只有子对话会被标成用户报的 Bug（有 submit_diagnosis、诊断弹窗、取消修复），
 * 普通对话里发 /bug 只把方法展开成一段要求，报告是一大段回复，没有弹窗、也没法取消修复。
 * 现在有项目、不能派子对话的顶层对话也就地标成 Bug，用同一套诊断弹窗和取消修复。
 * - 父对话（能派子对话）不标：它的 /bug 是派一个 kind: "bug" 的子对话。
 * - Chat 页（没有项目）不标：没有项目就没有改动核对、临时日志清理和 Bug 记录，仍按回复里写报告处理。
 * - 普通对话不像子对话那样只做这一件事：Bug 结束（修好了、不修了且临时日志删完）后照常聊、照常改文件，
 *   不再按诊断阶段拦改文件（server/hooks/guards.ts 的 bugDeny）。
 * 状态只看报告的阶段和用户的决定（bugOutcome），不看回复文字
 */
import { cleaning } from './bug-phase.ts'
import { bugOutcome } from './bug-stats.ts'
import { turnRole } from './conv-mode.ts'
import type { Agent, Task } from './schema.ts'

type Where = Pick<Task, 'projectId' | 'mode' | 'agentId'> & { parentTaskId?: string }

/** 这个对话里用户发 /bug 时能不能就地标成用户报的 Bug：子对话，或有项目、角色不能派子对话的顶层对话 */
export function bugInPlace(task: Where, agents: Agent[]): boolean {
  if (task.parentTaskId) return true
  if (!task.projectId || task.mode === 'workflow') return false
  return !turnRole(task, agents, task.agentId)?.canDelegate
}

/**
 * 普通对话（没有父对话）里的 Bug 已经结束：修好了（验证那一版点了结束）、或不修了且临时日志删完。
 * 子对话不算：它就是为这个 Bug 开的，结束后也不该再改别的
 */
export function inPlaceBugClosed(task: Pick<Task, 'bug' | 'parentTaskId'> & { resolved?: boolean }) {
  if (!(task.bug?.kind === 'report') || task.parentTaskId) return false
  const outcome = bugOutcome({ id: '', createdAt: '', resolved: task.resolved, diagnoses: task.bug?.diagnoses })
  if (outcome === 'fixed') return true
  return outcome === 'cancelled' && !cleaning(task.bug?.diagnoses?.at(-1))
}
