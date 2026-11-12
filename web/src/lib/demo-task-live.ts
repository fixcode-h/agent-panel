import type { Task } from '@shared/schema'
import { descendantNeeds } from '@shared/child-needs'
import { taskLiveOf, type TaskLive } from '@shared/task-live'
import { demoChildActive, demoCliAlive } from './demo-processes'

/**
 * 演示版的运行时状态：和正式后端 server/tasks/live.ts 一样只在一处算，经同一个 taskLiveOf 得出 state。
 * 演示里没有真的进程和后台命令：CLI 存活用 demoCliAlive，后台命令就是演示数据里挂在任务上的 jobs
 */
export function demoLive(tasks: Task[], t: Task, needs = descendantNeeds(tasks)): TaskLive {
  const top = !t.parentTaskId
  const kids = top ? tasks.filter((k) => k.parentTaskId === t.id && !k.deletedAt) : []
  return taskLiveOf(t, {
    cliAlive: demoCliAlive(t),
    jobs: t.jobs ?? [],
    childrenWorking: kids.filter(demoChildActive).length,
    childrenCli: kids.filter(demoCliAlive).length,
    childrenNeeds: needs.get(t.id) ?? 0,
  })
}

/** 和正式后端的 withLegacy 一样：新旧两种形状并存，live 之外旧的几个字段照样叠上 */
export function demoWithLive(tasks: Task[], t: Task, needs?: Map<string, number>): Task & { live: TaskLive } {
  const live = demoLive(tasks, t, needs)
  const { cliAlive, childrenWorking, childrenCli, childrenNeeds } = live
  const kids = t.parentTaskId ? { childrenNeeds } : { childrenWorking, childrenCli, childrenNeeds }
  return { ...t, cliAlive, ...kids, live }
}
