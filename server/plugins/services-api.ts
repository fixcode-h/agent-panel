import { Hono } from 'hono'
import { pluginServicesContract as C } from '../../shared/api-contract/plugin-services.ts'
import { serviceStatuses, startService, stopService } from './services.ts'

/** 插件托管进程的接口（契约 shared/api-contract/plugin-services.ts），挂在 /api/plugins 下 */
export function pluginServicesApi() {
  const fail = (e: unknown) => ({ error: (e as Error).message })
  return new Hono()
    .get('/:id/services', (c) => c.json(serviceStatuses(c.req.param('id'))))
    .post('/:id/services/:sid/start', async (c) => {
      C.start.body.parse(await c.req.json().catch(() => ({})))
      try {
        return c.json(await startService(c.req.param('id'), c.req.param('sid')))
      } catch (e) {
        return c.json(fail(e), 404)
      }
    })
    .post('/:id/services/:sid/stop', (c) => {
      try {
        return c.json(stopService(c.req.param('id'), c.req.param('sid')))
      } catch (e) {
        return c.json(fail(e), 404)
      }
    })
}
