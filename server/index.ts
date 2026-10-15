import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { z } from 'zod'
import { AgentInput } from '../shared/schema.ts'
import { getCli } from '../shared/clis.ts'
import { store } from './store.ts'
import { detectClis } from './detect.ts'

const app = new Hono().basePath('/api')

function parseInput(body: unknown) {
  const parsed = AgentInput.safeParse(body)
  if (!parsed.success) return { error: z.prettifyError(parsed.error) }
  if (!getCli(parsed.data.cli)) return { error: `未知的 CLI：${parsed.data.cli}` }
  return { data: parsed.data }
}

app.get('/health', (c) => c.json({ ok: true }))

app.get('/clis', async (c) => c.json(await detectClis(c.req.query('refresh') === '1')))

app.get('/agents', async (c) => c.json(await store.list()))

app.post('/agents', async (c) => {
  const r = parseInput(await c.req.json())
  if (r.error) return c.json({ error: r.error }, 400)
  return c.json(await store.create(r.data!), 201)
})

app.put('/agents/:id', async (c) => {
  const r = parseInput(await c.req.json())
  if (r.error) return c.json({ error: r.error }, 400)
  const agent = await store.update(c.req.param('id'), r.data!)
  return agent ? c.json(agent) : c.json({ error: 'Agent 不存在' }, 404)
})

app.post('/agents/:id/main', async (c) => {
  const agents = await store.setMain(c.req.param('id'))
  return agents ? c.json(agents) : c.json({ error: 'Agent 不存在' }, 404)
})

app.delete('/agents/:id', async (c) => {
  const ok = await store.remove(c.req.param('id'))
  return ok ? c.body(null, 204) : c.json({ error: 'Agent 不存在' }, 404)
})

const root = new Hono()
root.route('/', app)
// 生产模式下直接托管前端构建产物
if (process.env.NODE_ENV === 'production') {
  root.use('/*', serveStatic({ root: './dist' }))
  root.get('*', serveStatic({ path: './dist/index.html' }))
}

const port = Number(process.env.PORT ?? 8787)
// 只监听本机：这个服务能启动本地 CLI，不应暴露到局域网
serve({ fetch: root.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`Agent 面板服务已启动: http://127.0.0.1:${port}`)
})
