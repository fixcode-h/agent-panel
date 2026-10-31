/**
 * 对话分两种（ADR 0037）：Chat 页的对话一问一答；项目里的顶层对话是 Agent 模式，面板推着它把事做完。
 * 放在单独的文件里：shared/task.ts 已经到了行数上限
 */
import type { Task } from './schema.ts'

/**
 * Chat 页的对话（没有项目的顶层对话）：直接和 Agent 聊，一问一答。不按计划推进、不挂派子任务这类编排工具，只留后台命令；
 * 项目里的对话是 Agent 模式，面板会推着它把任务做完（见 docs/adr/0037-chat-and-agent-modes.md）
 */
export const isPlainChat = (tk: Pick<Task, 'mode' | 'projectId' | 'parentTaskId'>) =>
  tk.mode === 'chat' && !tk.projectId && !tk.parentTaskId

/** Agent 模式的顶层对话同一个进度最多推几次（ADR 0037）；子对话推不动会上报父对话、Chat 页一问一答，都只推一次 */
export const AGENT_NUDGE_MAX = 3
export const nudgeMax = (tk: Pick<Task, 'mode' | 'projectId' | 'parentTaskId'>) =>
  tk.parentTaskId || isPlainChat(tk) ? 1 : AGENT_NUDGE_MAX

/**
 * 面板推对话「接着做」的计数：key 是进度（计划 id + 已完成几步，或「said:用户消息 id」），进度变了从 1 重新数。
 * 返回推完之后的记录（n 是这是第几次）；推满了返回 null
 */
export function nextNudge(prev: { key: string; n: number } | undefined, key: string, max: number) {
  const n = prev?.key === key ? prev.n + 1 : 1
  return n > max ? null : { key, n }
}
