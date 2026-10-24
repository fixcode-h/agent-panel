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
