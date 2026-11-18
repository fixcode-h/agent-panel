import type { Task, TaskJob } from '@shared/schema'
import type { LiveUrl } from '@shared/turn-outputs/local-url'

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

/**
 * 演示里后台命令认出的本机地址（正式版见 server/bg/url.ts，经 live.urls 交给页面）：
 * 演示对话最后一轮起了一个开发服务器（效果图 6），停止、重新运行只改这张表。只在内存里，刷新页面回到初始样子
 */
export const demoUrlStore: { map: Record<string, LiveUrl[]> } = { map: {} }

export const demoUrls = (t: Pick<Task, 'id'>): LiveUrl[] => demoUrlStore.map[t.id] ?? []

/** POST /tasks/:id/jobs/:jobId/stop|rerun：演示里没有进程，只把那一行改成已停止 / 运行中 */
export function demoJobAction(t: Pick<Task, 'id'>, jobId: string, action: string) {
  const u = demoUrls(t).find((x) => x.job === jobId)
  if (!u) return { ok: false, info: '没有这条后台命令' }
  if (action === 'stop') {
    if (u.state === 'stopped') return { ok: false, info: `编号 ${jobId} 已经结束了（已停止）` }
    u.state = 'stopped'
    return { ok: true, info: '已停止' }
  }
  if (u.state === 'running') return { ok: false, info: '这条命令还在跑' }
  u.state = 'running'
  u.startedAt = new Date().toISOString()
  return { ok: true, id: jobId, info: '已重新运行' }
}
