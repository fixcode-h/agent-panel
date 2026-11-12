/**
 * 对话回收站的列表（GET /tasks/trash）：正式后端和演示后端都调这一份（重构文档第 10 条），字段对着
 * shared/api-contract/trash.ts 的 TrashRow。父对话和子对话一起删的只列父对话，子对话数记在 children 上
 */
import type { Task } from '../schema.ts'
import { taskDeleted, trashLeftDays } from '../task.ts'
import type { TrashRow } from '../api-contract/trash.ts'

export function trashRows(
  all: Pick<Task, 'id' | 'title' | 'projectId' | 'parentTaskId' | 'deletedAt' | 'worktree'>[],
  now = Date.now(),
): TrashRow[] {
  const deleted = all.filter((t) => taskDeleted(t))
  const parents = new Set(deleted.filter((t) => !t.parentTaskId).map((t) => t.id))
  return (
    deleted
      .filter((t) => !t.parentTaskId || !parents.has(t.parentTaskId))
      .map((t) => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        parentTaskId: t.parentTaskId ?? '',
        deletedAt: t.deletedAt!,
        leftDays: trashLeftDays(t.deletedAt!, now),
        children: deleted.filter((k) => k.parentTaskId === t.id).length,
        worktree: t.worktree?.state ?? '',
      }))
      // 最近删掉的排在前面：要恢复的往往是刚删错的那条
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  )
}
