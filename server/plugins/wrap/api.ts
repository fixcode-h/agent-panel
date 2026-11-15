import { Hono } from 'hono'
import { pluginWrapContract as W } from '../../../shared/api-contract/plugin-wrap.ts'
import { buildAiPrompt, resolveRecipe } from './ai.ts'
import { fetchRepo, parseWrapUrl } from './fetch.ts'
import { wrapPreview } from './preview.ts'

/**
 * 从 GitHub 链接包装插件的接口（ADR 0068），挂在 /api/plugins/wrap 下。预览返回的 token 和其他安装方式一样，
 * 确认走 /api/plugins/install/confirm
 */
const fail = (e: unknown) => ({ error: (e as Error).message })

export function wrapApi() {
  return new Hono()
    .post('/preview', async (c) => {
      const body = W.preview.body.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: '参数不对' }, 400)
      try {
        return c.json(await wrapPreview(body.data))
      } catch (e) {
        return c.json(fail(e), 400)
      }
    })
    .post('/ai-prompt', async (c) => {
      const body = W.aiPrompt.body.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: '参数不对' }, 400)
      try {
        const { repo, ref } = parseWrapUrl(body.data.url)
        return c.json({ prompt: buildAiPrompt(await fetchRepo({ repo, ref })) })
      } catch (e) {
        return c.json(fail(e), 400)
      }
    })
    .post('/ai-resolve', async (c) => {
      const body = W.aiResolve.body.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: '参数不对' }, 400)
      try {
        return c.json(resolveRecipe(parseWrapUrl(body.data.url).repo, body.data.text))
      } catch (e) {
        return c.json(fail(e), 400)
      }
    })
}
