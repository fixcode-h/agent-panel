import { Hono } from 'hono'
import { pluginSecretsContract as C } from '../../shared/api-contract/plugin-secrets.ts'
import { secretHints, setSecret } from '../secrets/store.ts'
import { findInstalled } from './manager.ts'

/** 插件保密项的接口（契约 shared/api-contract/plugin-secrets.ts），挂在 /api/plugins 下 */
export function pluginSecretsApi() {
  return new Hono()
    .get('/:id/secrets', async (c) => c.json(await secretHints(`plugin:${c.req.param('id')}`)))
    .put('/:id/secrets', async (c) => {
      const id = c.req.param('id')
      const p = findInstalled(id)
      if (!p) return c.json({ error: '没有装这个插件' }, 404)
      const patch = C.save.body.safeParse(await c.req.json().catch(() => null))
      if (!patch.success) return c.json({ error: '保密项格式不对' }, 400)
      // 只收清单里声明成 secret 的键：网页传别的键不能往保密存储里塞东西
      const keys = new Set(p.manifest.settings.filter((s) => s.type === 'secret').map((s) => s.key))
      for (const [k, v] of Object.entries(patch.data)) if (keys.has(k)) await setSecret(`plugin:${id}`, k, v.trim())
      return c.json(await secretHints(`plugin:${id}`))
    })
}
