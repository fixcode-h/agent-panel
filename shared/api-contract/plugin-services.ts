/**
 * 插件托管进程的接口契约（插件接口 11 的 services，server/plugins/services.ts；写法见 ./define.ts）。
 * 挂在 /api/plugins/:id/services 下。状态变化另外走插件推送通道（事件名 service，数据同 ServiceStatus）。
 *
 * 没进 probe.ts：探查跑在没装插件的数据目录上，没有能起的进程；接口形状由 server/plugins/services.test.ts 按 res 查
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

export const ServiceStatus = z.object({
  plugin: z.string(),
  id: z.string(),
  /** stopped 没在跑；starting 起了、健康检查还没过；running 能用；failed 起不来或自己退出了 */
  state: z.enum(['stopped', 'starting', 'running', 'failed']),
  /** 分到的端口（只绑 127.0.0.1），没在跑时为 0 */
  port: z.number(),
  /** 出错原因（原样给用户看）：起不来、健康检查超时、退出码 */
  error: z.string(),
  /** 日志文件的绝对路径（plugin-data/<id>/logs/<进程>.log），没起过为空 */
  log: z.string(),
  /** 这次起来的时间，没在跑为空 */
  startedAt: z.string(),
})
export type ServiceStatus = z.infer<typeof ServiceStatus>

export const pluginServicesContract = {
  list: endpoint({ method: 'GET', path: '/plugins/:id/services', res: z.array(ServiceStatus) }),
  /** 起来并等健康检查通过才返回（失败时 state = failed，error 写原因）；已经在跑的直接返回 */
  start: endpoint({ method: 'POST', path: '/plugins/:id/services/:sid/start', body: z.object({}), res: ServiceStatus }),
  stop: endpoint({ method: 'POST', path: '/plugins/:id/services/:sid/stop', body: z.object({}), res: ServiceStatus }),
}
