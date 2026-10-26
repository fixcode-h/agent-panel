import type { WorktreeItem } from './api'

/**
 * 环境弹窗里「独立分支」的列表顺序：当前对话（父对话）恒在第一位，
 * 其余子对话按对话创建时间从早到晚；时间相同按 taskId 兜底，刷新、合并前后都不跳。
 */
export function orderWorktrees(items: WorktreeItem[]) {
  return [...items].sort((a, b) => {
    if (a.child !== b.child) return a.child ? 1 : -1
    return a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId)
  })
}

/**
 * 「独立分支」按删除与否分成两组：`live` 是分支还在的（state 为 active），
 * `removed` 是已经删掉的（合并掉了或直接删了）。已删除的项后端仍会返回（task 上的记录留着），
 * 所以两组都要显示，不能把它们过滤掉。
 */
export function groupWorktrees(items: WorktreeItem[]) {
  return {
    live: orderWorktrees(items.filter((x) => x.state === 'active')),
    removed: orderWorktrees(items.filter((x) => x.state !== 'active')),
  }
}
