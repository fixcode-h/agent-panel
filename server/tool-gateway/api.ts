/**
 * 工具网关的接口（契约 shared/api-contract/tool-gateway.ts）：调用记录、统计、网关模式、能力表。
 * 列表和统计的逻辑在 shared/tool-gateway/（演示后端调同一份），这里只取数据、校验入参
 */
import { Hono } from 'hono'
import { toolGatewayContract as G } from '../../shared/api-contract/tool-gateway.ts'
import { gatewayStats } from '../../shared/tool-gateway/stats.ts'
import { GATEWAY_MODE_DEFS } from '../../shared/tool-gateway/types.ts'
import { callPage, callQueryOf, capabilityViews, settingsView } from '../../shared/tool-gateway/views.ts'
import { t } from '../../shared/i18n.ts'
import { readHooks, setGatewayMode } from '../hooks/store.ts'
import { recentCalls } from './call-log.ts'
import { routesOf } from './routes-state.ts'

export function toolGatewayApi(deps: {
  projects: { get: (id: string) => Promise<{ id: string; path: string } | null | undefined> }
}) {
  // 不带 projectId 时所有项目合在一起
  const records = (projectId: string | undefined) => recentCalls(projectId || undefined)
  return new Hono()
    .get('/calls', (c) =>
      c.json(
        callPage(
          records(c.req.query('projectId')),
          callQueryOf((k) => c.req.query(k)),
        ),
      ),
    )
    .get('/stats', (c) => {
      const n = Math.min(500, Math.max(1, Number(c.req.query('n')) || 200))
      return c.json(gatewayStats(records(c.req.query('projectId')), n))
    })
    .get('/settings', async (c) => c.json(settingsView((await readHooks()).gateway.mode)))
    .put('/settings', async (c) => {
      const body = G.setSettings.body.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      // 改道（enforce）这一期还没开放：只给选注册表里开放了的
      if (!GATEWAY_MODE_DEFS.find((m) => m.id === body.data.mode)?.available)
        return c.json({ error: t('这个模式还没开放') }, 400)
      await setGatewayMode(body.data.mode)
      return c.json(settingsView(body.data.mode))
    })
    .get('/capabilities', async (c) => {
      const id = c.req.query('projectId') ?? ''
      const p = id ? await deps.projects.get(id) : null
      const routes = await routesOf(p ? { id: p.id, path: p.path } : undefined)
      return c.json(capabilityViews(records(id), routes))
    })
}
