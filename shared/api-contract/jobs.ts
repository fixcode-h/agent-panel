/**
 * 后台命令的页面操作（写法见 ./define.ts）：本轮产出里「可浏览的地址」那一行的停止、重新运行
 * （设计稿 designs/Bug模式子对话体验-设计稿.md 第 4 节）。
 *
 * - stop：停掉这一条命令（开发服务器），结果照后台命令的老规矩不推回对话。
 * - rerun：按原来的命令和目录再起一次，当常驻服务跑；是用户点的，不是对话让跑的，结果不推回对话。
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

const JobAction = z.object({
  ok: z.boolean(),
  /** 新起的那条的编号（rerun） */
  id: z.string().optional(),
  /** 结果说明，失败时是原因 */
  info: z.string(),
})

export const jobsContract = {
  stop: endpoint({ method: 'POST', path: '/tasks/:id/jobs/:jobId/stop', body: z.object({}), res: JobAction }),
  rerun: endpoint({ method: 'POST', path: '/tasks/:id/jobs/:jobId/rerun', body: z.object({}), res: JobAction }),
}
