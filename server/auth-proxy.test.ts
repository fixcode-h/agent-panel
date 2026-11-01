import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 令牌开关关着（默认）：本机访问免令牌，经过反代转发来的必须要
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-auth-proxy-'))
process.env.AGENT_PANEL_DATA = dir
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ requireToken: false }), 'utf8')

const { Hono } = await import('hono')
const { tokenGuard } = await import('./auth.ts')

test('反代把 Host 改成 127.0.0.1 时：带转发头的请求按外网处理，要令牌', async () => {
  const app = new Hono()
  app.use('*', tokenGuard)
  app.all('*', (c) => c.text('ok'))
  const call = (headers: Record<string, string>) =>
    app.request('http://127.0.0.1:8787/api/tasks', { headers: { host: '127.0.0.1:8787', ...headers } })
  assert.equal((await call({})).status, 200, '真正的本机访问照旧免令牌')
  for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'])
    assert.equal((await call({ [h]: '203.0.113.9' })).status, 401, `带 ${h} 的要令牌`)
})
