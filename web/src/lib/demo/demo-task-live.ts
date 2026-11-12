import { demoJobs } from './demo-jobs'
import type { Task } from '@shared/schema'
import { childCountsScan, type ChildCounts } from '@shared/children/row'
import { taskLiveOf, type TaskLive } from '@shared/live/task-live'
import { demoChildActive, demoCliAlive } from '../demo-processes'

/** 名下子对话的三项计数：和正式版同一份扫法（shared/children/row.ts），回收站里的不算 */
export const demoChildCounts = (tasks: Task[]) =>
  childCountsScan(
    tasks.filter((t) => !t.deletedAt),
    { active: demoChildActive, cliAlive: demoCliAlive },
  )

/**
 * 演示版的运行时状态：和正式后端 server/tasks/live.ts 一样只在一处算，经同一个 taskLiveOf 得出 state。
 * 演示里没有真的进程和后台命令：CLI 存活用 demoCliAlive，后台命令按 demo/demo-jobs.ts 那张表。
 * 列表里逐个算时把 counts 一次扫好传进来，不每个任务扫一遍
 */
export function demoLive(
  tasks: Task[],
  t: Task,
  counts: (id: string) => ChildCounts = demoChildCounts(tasks),
): TaskLive {
  const c = counts(t.id)
  // 和正式版一样：在跑的子对话数、CLI 数只给顶层对话，子对话页只冒泡后代在等你的个数
  const top = !t.parentTaskId
  return taskLiveOf(t, {
    cliAlive: demoCliAlive(t),
    jobs: demoJobs(t),
    childrenWorking: top ? c.childrenWorking : 0,
    childrenCli: top ? c.childrenCli : 0,
    childrenNeeds: c.childrenNeeds,
  })
}

/** 和正式后端的 withLive 一样：交给页面的任务带上 live，运行时字段只在 live 里 */
export function demoWithLive(tasks: Task[], t: Task, counts?: (id: string) => ChildCounts): Task & { live: TaskLive } {
  return { ...t, live: demoLive(tasks, t, counts) }
}
