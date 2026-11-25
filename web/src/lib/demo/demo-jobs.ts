import type { Task, TaskJob, TaskMessage } from '@shared/schema'
import { bgResultHead } from '@shared/panel-tools'
import { fmtDuration } from '@shared/duration'
import { bgResultLetter, bgUserStopHead } from '@shared/prompt/letters/background'
import { settleJobRow } from '@shared/jobs/job-row'
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

/**
 * 运行区、工具行的「终止」（POST …/stop 带 tellAgent）：演示里没有进程，把这条命令从还在跑的里拿掉，
 * 并像正式后端一样往对话里记一条推回给 Agent 的结果（措辞和 server/background.ts 用的是同一份 shared 里的信）。
 * 不认识的编号返回 undefined，交给下面「可浏览的地址」那张表
 */
function demoStopLiveJob(task: Task, jobId: string, tellAgent: boolean) {
  const list = demoJobs(task)
  const job = list.find((j) => j.id === jobId)
  if (!job) return undefined
  setDemoJobs(
    task,
    list.filter((j) => j.id !== jobId),
  )
  const ms = Math.max(0, Date.now() - Date.parse(job.startedAt || new Date().toISOString()))
  const head = bgUserStopHead(job.name, fmtDuration(ms))
  // 发起它的那一行（run_background）接上结果、不再转圈：和正式后端同一份收口逻辑
  settleJobRow(task, job.id, `${bgResultHead(job.id)}${head}`, false, ms, '用户终止')
  if (tellAgent) {
    const msg: TaskMessage = {
      id: `demo-stop-${jobId}-${Date.now()}`,
      role: 'system',
      agentId: '',
      step: '',
      text:
        bgResultHead(job.id) + bgResultLetter({ head, changed: false, command: job.command, body: '', byUser: true }),
      tools: [],
      panel: 'background',
      at: new Date().toISOString(),
    }
    task.messages.push(msg)
    task.updatedAt = msg.at
  }
  return { ok: true, info: '已停止' }
}

/**
 * POST /tasks/:id/jobs/:jobId/stop|rerun：演示里没有进程。还在跑的命令（运行区那一行）停了就拿掉；
 * 「可浏览的地址」那张表只把那一行改成已停止 / 运行中
 */
export function demoJobAction(t: Task | Pick<Task, 'id'>, jobId: string, action: string, body?: unknown) {
  if (action === 'stop' && 'messages' in t) {
    const live = demoStopLiveJob(t, jobId, !!(body as { tellAgent?: boolean } | null)?.tellAgent)
    if (live) return live
  }
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
