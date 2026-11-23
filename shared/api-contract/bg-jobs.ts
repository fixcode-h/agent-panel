/**
 * 后台作业的接口契约（ADR 0075）：侧栏底部的作业列表取全部、看一条的日志、取消
 */
import { z } from 'zod'
import { BgJob, BgJobLog } from '../jobs/types.ts'
import { endpoint } from './define.ts'

export const bgJobsContract = {
  list: endpoint({ method: 'GET', path: '/bg-jobs', res: z.object({ jobs: z.array(BgJob) }) }),
  /** 查询参数 from：从第几行开始 */
  log: endpoint({ method: 'GET', path: '/bg-jobs/:id/log', res: BgJobLog }),
  cancel: endpoint({
    method: 'POST',
    path: '/bg-jobs/:id/cancel',
    body: z.object({}),
    res: z.object({ ok: z.boolean(), info: z.string() }),
  }),
  /** 清掉已经结束的 */
  clear: endpoint({
    method: 'POST',
    path: '/bg-jobs/clear',
    body: z.object({}),
    res: z.object({ jobs: z.array(BgJob) }),
  }),
}
