/**
 * 从完整任务裁出 Agent 流程数据的精简行（扩展 4，汇总见 shared/agent-stats.ts）。
 * 接口 GET /tasks/flow 返回它的结果，评测脚本（scripts/real-cli/eval.mjs）也用同一个口径。
 * 列表接口给的任务只带用户消息：合回失败认的是父对话发来的那条消息（role 为 user、带 peer），照样数得到
 */
import type { FlowBrief } from './agent-stats.ts'
import { isChatMode } from './conv-mode.ts'
import type { Task } from './schema.ts'
import { reworkCounts } from './task-export.ts'
import { taskDeleted, waitDuration } from './task.ts'

/** 往上找到顶层对话，以及它名下的那一层：对话页只能在顶层对话的右栏里打开它的直接子对话 */
function rootPane(tk: Task, byId: Map<string, Task>) {
  let root = tk
  let pane = tk
  const seen = new Set([tk.id])
  for (;;) {
    const up = byId.get(root.parentTaskId ?? '')
    if (!up || seen.has(up.id)) break
    seen.add(up.id)
    pane = root
    root = up
  }
  return { root, pane }
}

/** 一个任务的流程数据 */
export function flowBrief(tk: Task, byId: Map<string, Task> = new Map(), now = Date.now()): FlowBrief {
  const { root, pane } = rootPane(tk, byId)
  const rw = reworkCounts(tk)
  const ends = { done: 0, blocked: 0 }
  for (const e of tk.turnEnds ?? []) if (e.outcome in ends) ends[e.outcome]++
  return {
    id: tk.id,
    title: tk.title,
    projectId: tk.projectId,
    parentTaskId: tk.parentTaskId ?? '',
    rootId: root.id === tk.id ? '' : root.id,
    paneId: pane.id,
    agentId: tk.agentId ?? '',
    createdAt: tk.createdAt,
    updatedAt: tk.updatedAt,
    bug: !!tk.bug,
    drives: tk.driveCount?.total ?? 0,
    turns: tk.turns?.length ?? 0,
    ends,
    reviewRejects: rw.review + (rw.sub ?? 0),
    mergeFails: rw.merge,
    merged: !!tk.resolved,
    waitMs: waitDuration(tk, now),
    tokens: (tk.usage?.inputTokens ?? 0) + (tk.usage?.outputTokens ?? 0),
    costUsd: tk.usage?.costUsd ?? 0,
  }
}

/**
 * 所有 Agent 模式对话（项目里的顶层对话和子对话，Chat 页的一问一答不算）裁成精简行。
 * tasks 传全部任务（要靠它找顶层对话）；进了回收站的不算（自己或顶层对话被删都算删了）
 */
export function agentFlowBriefs(tasks: Task[], now = Date.now()): FlowBrief[] {
  const byId = new Map(tasks.map((x) => [x.id, x]))
  const out: FlowBrief[] = []
  for (const tk of tasks) {
    if (taskDeleted(tk) || isChatMode(tk) || !tk.projectId) continue
    const brief = flowBrief(tk, byId, now)
    if (brief.rootId && taskDeleted(byId.get(brief.rootId) ?? {})) continue
    out.push(brief)
  }
  return out
}
