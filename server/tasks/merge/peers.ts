import { type Task } from '../../../shared/schema.ts'
import { taskDeleted } from '../../../shared/task.ts'
import type { TasksScope } from '../scope.ts'
import { freshTask } from '../read.ts'

/** 同一项目里的其他父对话（顶层对话），最近活动的在前 */
export async function peerList(sc: TasksScope, self: Task) {
  return (
    (await sc.store.list())
      // 进了回收站的对话不算同项目里能互相发消息的一条（它在列表里也已经看不到了）
      .filter(
        (x) =>
          x.projectId === self.projectId &&
          !x.parentTaskId &&
          !x.flowRun &&
          x.id !== self.id &&
          !x.archived &&
          !taskDeleted(x),
      )
      .map((x) => freshTask(sc, x))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
  )
}
