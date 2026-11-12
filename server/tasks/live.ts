import type { Task } from '../../shared/schema.ts'
import { taskLiveOf, type TaskLive } from '../../shared/live/task-live.ts'
import { reapLostJobs, uiJobs } from '../background.ts'
import { taskCliAlive } from '../exec/process.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'
import type { ChildCounts as ScanCounts } from '../../shared/children/row.ts'

/** 交给界面的任务：记录本身加上 live（运行时状态） */
export type TaskWithLive = Task & { live: TaskLive }

/** 名下子对话的计数（server/tasks/children.ts 的 childCountsOf，结果按 1 秒缓存） */
type ChildCounts = (parentId: string) => Promise<{ working: number; cli: number; needs: number }>

/** 调用方刚扫好的一份计数（shared/children/row.ts 的 childCountsScan）：列表接口用它，不读 1 秒缓存 */
type FreshCounts = (parentId: string) => ScanCounts

/**
 * 对话的运行时状态只在这里算（重构文档第 1 条）：进程登记、后台命令、名下子对话的计数，
 * 再经 shared/live/task-live.ts 的 taskLiveOf 得出 state。列表、详情、实时推送、全局事件流都调这一处，
 * 不在各个路由里各往 Task 上叠字段。
 */
export function createLive(sc: TasksScope, childCounts: ChildCounts) {
  async function liveOf(task: Task, fresh?: FreshCounts): Promise<TaskLive> {
    const f = fresh?.(task.id)
    const kids = f
      ? { working: f.childrenWorking, cli: f.childrenCli, needs: f.childrenNeeds }
      : await childCounts(task.id)
    // 子对话页只冒泡后代在等你的个数（它下面还有孙对话时也要显示「等你处理」）；
    // 在跑的子对话数、CLI 数只给顶层对话（和以前列表、详情带的口径一样）
    const top = !task.parentTaskId
    return taskLiveOf(task, {
      cliAlive: taskCliAlive(task.id),
      jobs: uiJobs(sc.background.list(task.id)),
      childrenWorking: top ? kids.working : 0,
      childrenCli: top ? kids.cli : 0,
      childrenNeeds: kids.needs,
    })
  }

  /** 交给界面的任务带上 live：运行时字段只在 live 里，任务记录本身不带（见 shared/live/task-live.ts） */
  async function withLive(task: Task): Promise<TaskWithLive> {
    // 面板上次被强杀、崩溃时还没结束的后台命令：记录跟着进程没了，那一行收口成「结果丢失」，不永远转圈
    if (reapLostJobs(task, sc.background.known, sc.background.lostNote)) {
      task.updatedAt = new Date().toISOString()
      const e = sc.live.get(task.id)
      if (e) e.rev++
      await sc.store
        .update(task.id, task)
        .catch((err) =>
          log.warn('background', '收口丢失的后台命令失败', { task: task.id, error: (err as Error).message }),
        )
    }
    return { ...task, live: await liveOf(task) }
  }

  return { liveOf, withLive }
}
