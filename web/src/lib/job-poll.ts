import type { TaskJobView } from '@shared/schema'

/**
 * 还在跑的时候多久拉一次输出。命令的输出是服务端内存里的最后几百行（见 server/background.ts 的 KEEP_LINES），
 * 不是逐条推过来的，点开窗口时按这个间隔拉整段就够了
 */
export const JOB_POLL_MS = 1000

/**
 * 拉输出失败后多久再试一次。失败不是终态：服务端重启、代理抖动时窗口不能就此停在旧输出上
 * 还继续显示「执行中」，那样用户会以为命令还在跑
 */
export const JOB_RETRY_MS = 2500

/** 排队中、跑着都要接着拉：排到它时窗口里要开始出输出，跑完要拿到最终输出和退出码 */
export const jobLive = (state: TaskJobView['state']) => state === 'queued' || state === 'running'

/**
 * 这一轮拉完之后下一次什么时候拉：返回 undefined 表示不用再拉（已经结束），窗口就停在这份结果上。
 * 拉失败（没拿到结果）也要接着试，不能就此停住——这是「窗口永久停在旧输出、徽标还写着执行中」的来源
 */
export function nextPollMs(result: TaskJobView | null): number | undefined {
  if (!result) return JOB_RETRY_MS
  return jobLive(result.state) ? JOB_POLL_MS : undefined
}

/** 窗口当前看到的那一份：哪条命令、最近一次读到的结果（失败时留着上一次的）、错误 */
export interface JobViewState {
  id: string
  view: TaskJobView | null
  error: string
}

/**
 * 这一轮的结果怎么合进窗口：拿到新结果就换掉，没拿到（失败）就保留上一次读到的输出，只更新错误。
 * 换了一条命令（id 变了）不能沿用上一条的输出
 */
export function mergeJobView(prev: JobViewState, id: string, result: TaskJobView | null, error: string): JobViewState {
  if (prev.id !== id) return { id, view: result, error }
  if (!result) return { ...prev, error }
  return { id, view: result, error }
}
