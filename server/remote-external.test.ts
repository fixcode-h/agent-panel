import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 外网专用端口：开着外网访问（自建反代）、本机不要求令牌
const free = await new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port
    s.close(() => resolve(p))
  })
})
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-remote-ext-'))
process.env.AGENT_PANEL_DATA = dir
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, 'settings.json'),
  JSON.stringify({
    requireToken: false,
    remoteAccess: { enabled: true, mode: 'custom', publicUrl: 'https://panel.example.com', localPort: free },
  }),
  'utf8',
)

const { Hono } = await import('hono')
const { tokenGuard } = await import('./auth.ts')
const { applyRemote, configureRemote, stopRemote } = await import('./remote.ts')

const app = new Hono()
app.use('*', tokenGuard)
app.all('*', (c) => c.text('ok'))

test('主端口：本机直接访问不要令牌，带转发头（反代把 Host 改成 127.0.0.1）的要令牌', async () => {
  const get = (headers: Record<string, string>) => app.request('http://127.0.0.1:8787/api/tasks', { headers })
  assert.equal((await get({ host: '127.0.0.1:8787' })).status, 200)
  assert.equal((await get({ host: '127.0.0.1:8787', 'x-forwarded-for': '1.2.3.4' })).status, 401)
  assert.equal((await get({ host: '127.0.0.1:8787', 'x-real-ip': '1.2.3.4' })).status, 401)
})

test('外网专用端口：Host 是什么都当外网，一律要令牌', async () => {
  configureRemote(app.fetch)
  await applyRemote()
  try {
    // 自建反代把 Host 改成 127.0.0.1，以前会被当成本机请求
    const r = await fetch(`http://127.0.0.1:${free}/api/tasks`)
    assert.equal(r.status, 401)
    const page = await fetch(`http://127.0.0.1:${free}/`)
    assert.equal(page.status, 401)
  } finally {
    await stopRemote()
  }
  // 停掉之后端口不再监听
  await assert.rejects(fetch(`http://127.0.0.1:${free}/api/tasks`))
})
