import type { Task, TaskJob } from '@shared/schema'

/**
 * 演示里对话上还在跑、排队的后台命令（正式版在服务端的后台命令管理里，经 live.jobs 交给页面）。
 * 后台命令不属于任务记录（shared/live/task-live.ts）：演示数据单独存一份，跟着演示库一起存进浏览器
 * （demo-backend.ts 的 load 把库里的那份挂到这里，改它就是改库）
 */
export const demoJobStore: { map: Record<string, TaskJob[]> } = { map: {} }

/** 这个对话还挂着的后台命令 */
export const demoJobs = (t: Pick<Task, 'id'>): TaskJob[] => demoJobStore.map[t.id] ?? []

/** 换掉这个对话的后台命令（空数组就是都结束了） */
export function setDemoJobs(t: Pick<Task, 'id'>, jobs: TaskJob[]) {
  if (jobs.length) demoJobStore.map[t.id] = jobs
  else delete demoJobStore.map[t.id] // delete-ok: 演示库里按对话 id 存的表，不是 Task
}
