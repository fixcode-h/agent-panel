/**
 * 后台作业的契约（ADR 0075）：面板和插件里能跑一阵子的事（编译、安装、下载、扫描、重建）都登记成一条作业，
 * 侧栏底部一处看全、能看日志、能取消。只放要显示的字段，日志单独取
 */
import { z } from 'zod'

export const BgJobStatus = z.enum(['running', 'done', 'failed', 'canceled'])
export type BgJobStatus = z.infer<typeof BgJobStatus>

export const BgJob = z.object({
  id: z.string(),
  /** 谁起的：panel 或插件 id */
  source: z.string(),
  /** 属于哪个面板项目（没有就是全局的） */
  projectId: z.string().optional(),
  /** 作业种类：build、install、download……（同一来源里分得开就行） */
  kind: z.string(),
  title: z.string(),
  status: BgJobStatus,
  /** 现在在做哪一步（一句话） */
  phase: z.string().optional(),
  /** 进度：done / total；没有 total 是不定进度 */
  done: z.number().optional(),
  total: z.number().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** 结束时的说明；失败时是原因 */
  info: z.string().optional(),
  cancelable: z.boolean(),
  /** 日志有多少行（取日志时用） */
  lines: z.number(),
})
export type BgJob = z.infer<typeof BgJob>

export const BgJobLog = z.object({
  lines: z.array(z.string()),
  /** 下一次从这里接着取 */
  next: z.number(),
  /** 太早的被丢掉了 */
  dropped: z.boolean().optional(),
})
export type BgJobLog = z.infer<typeof BgJobLog>

/** 侧栏汇总：跑着的在前，其余按结束时间倒序 */
export function sortJobs(list: BgJob[]) {
  return [...list].sort(
    (a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') ||
      (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt),
  )
}
