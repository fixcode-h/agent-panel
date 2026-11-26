/**
 * 外部服务代理的接口（契约 shared/api-contract/mcp-proxy.ts）：「给 Agent 的工具」和代理开关。
 * 开关存在钩子设置的 gateway 段里（和网关模式一起导出、备份）
 */
import { Hono } from 'hono'
import { mcpProxyContract as P } from '../../shared/api-contract/mcp-proxy.ts'
import { externalClaims } from '../../shared/mcp-proxy/exposure.ts'
import { exposureView } from '../../shared/mcp-proxy/view.ts'
import { readHooks, setMcpProxy } from '../hooks/store.ts'
import { pluginFindSources } from '../plugins/find-sources.ts'
import { exposureRuns } from './state.ts'

export function mcpProxyApi(deps: {
  projects: { get: (id: string) => Promise<{ id: string; path: string } | null | undefined> }
}) {
  return new Hono()
    .get('/exposure', async (c) => {
      const id = c.req.query('projectId') ?? ''
      const p = id ? await deps.projects.get(id) : null
      const sources = p ? await pluginFindSources({ id: p.id, path: p.path }).catch(() => []) : []
      const claims = externalClaims(sources.map((s) => ({ tool: s.tool, by: s.id.split(':')[0] })))
      return c.json(exposureView((await readHooks()).gateway.mcpProxy, await exposureRuns(id || undefined), claims))
    })
    .put('/settings', async (c) => {
      const body = P.setSettings.body.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      await setMcpProxy(body.data.enabled)
      return c.json({ enabled: body.data.enabled })
    })
}
