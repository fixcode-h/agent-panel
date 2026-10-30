/**
 * 跨项目的对话总览（左侧图标栏「对话总览」）：所有项目的顶层对话按「要不要你管」分组。
 * 侧栏是「项目 → 对话」树、每个项目只露几条，项目一多就看不出哪些在等你、哪些停住了；
 * 这里只做分组和排序，状态判定全部读 shared/task.ts（taskState / taskBusy / taskDoneDot）和 openPlan。
 */
import { openPlan } from './plan.ts'
import type { Task } from './schema.ts'
import { askedAt, taskDeleted, taskDoneDot, taskState, taskTurnUnread, type ConvState } from './task.ts'

/** you：等你处理（提问、失败、做完没看）；stalled：停住了（计划没做完、也没在跑）；running：执行中或在等结果 */
export type OverviewGroup = 'you' | 'stalled' | 'running' | 'rest'

export const OVERVIEW_GROUPS: OverviewGroup[] = ['you', 'stalled', 'running', 'rest']

export interface OverviewRow {
  task: Task
  group: OverviewGroup
  state: ConvState
  /** 名下（含多层）还在动的子对话数 */
  kidsBusy: number
  /** 自己加名下全部子对话的 token（输入 + 输出） */
  tokens: number
  plan?: { done: number; total: number }
}

const tokensOf = (tk: Task) => (tk.usage?.inputTokens ?? 0) + (tk.usage?.outputTokens ?? 0)

/**
 * 分好组的行：每组按最后活动从新到旧。只列顶层对话（子对话算进父对话的 token 和「在跑的子对话」），
 * 回收站里的、归档的不列
 */
export function overviewRows(tasks: Task[]): OverviewRow[] {
  const kids = new Map<string, Task[]>()
  for (const tk of tasks)
    if (tk.parentTaskId && !taskDeleted(tk)) kids.set(tk.parentTaskId, [...(kids.get(tk.parentTaskId) ?? []), tk])
  const subtree = (id: string, seen = new Set<string>()): Task[] => {
    if (seen.has(id)) return []
    seen.add(id)
    return (kids.get(id) ?? []).flatMap((k) => [k, ...subtree(k.id, seen)])
  }
  const rows: OverviewRow[] = []
  for (const tk of tasks) {
    if (tk.parentTaskId || tk.archived || taskDeleted(tk)) continue
    const below = subtree(tk.id)
    const state = taskState(tk)
    const plan = openPlan(tk)
    const busy = state === 'running' || state === 'waiting'
    const group: OverviewGroup =
      state === 'needs' || state === 'failed' || taskDoneDot(tk, taskTurnUnread(tk))
        ? 'you'
        : busy
          ? 'running'
          : plan && !(state === 'stopped' && tk.stopReason === 'user')
            ? 'stalled'
            : 'rest'
    rows.push({
      task: tk,
      group,
      state,
      kidsBusy: below.filter((k) => {
        const s = taskState(k)
        return s === 'running' || s === 'waiting' || s === 'needs'
      }).length,
      tokens: tokensOf(tk) + below.reduce((n, k) => n + tokensOf(k), 0),
      plan,
    })
  }
  const at = (r: OverviewRow) => r.task.updatedAt || askedAt(r.task)
  return rows.sort(
    (a, b) => OVERVIEW_GROUPS.indexOf(a.group) - OVERVIEW_GROUPS.indexOf(b.group) || at(b).localeCompare(at(a)),
  )
}
