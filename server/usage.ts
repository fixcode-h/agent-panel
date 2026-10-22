import { Hono, type Context } from 'hono'
import type { Task } from '../shared/schema.ts'
import { UsageQuery, usageReport } from '../shared/usage.ts'

/**
 * 用量统计接口：把各任务每轮执行的 token 按天 / 周 / 月聚合后给设置页。
 * 聚合在服务端做（任务多时前端只拿几十个桶，不会把全部任务传给浏览器）。
 */
export function usageApi(deps: {
  /** 所有任务的列表（和任务页用的是同一份数据） */
  tasks: { list(): Promise<Task[]> }
}) {
  const routes = new Hono()
  const bad = (c: Context, error: string) => c.json({ error }, 400)

  routes.get('/', async (c) => {
    const grain = UsageQuery.grain(c.req.query('grain'))
    const count = UsageQuery.count(c.req.query('count'), grain)
    try {
      return c.json(usageReport(await deps.tasks.list(), { grain, count }))
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  return { routes }
}
