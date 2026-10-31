import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的，打开「访问令牌」
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-auth-'))
process.env.AGENT_PANEL_DATA = dir
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ requireToken: true }), 'utf8')

const { Hono } = await import('hono')
const { accessToken, tokenGuard, tokenMatches } = await import('./auth.ts')

test('打开访问令牌后，CLI 调的面板工具地址照样能用，其他接口要令牌', async () => {
  const app = new Hono()
  app.use('*', tokenGuard)
  app.all('*', (c) => c.text('ok'))
  const call = (p: string) =>
    app.request(`http://127.0.0.1:8787${p}`, { method: 'POST', headers: { host: '127.0.0.1:8787' } })
  // CLI 拿着这一轮的随机地址来调，没有 Cookie：拦下来 CLI 就一个面板工具都没有（Pi 的面板工具全丢就是这样）
  assert.equal((await call('/api/mcp/ask/some-token')).status, 200)
  assert.equal((await call('/api/mcp/design/some-token')).status, 200)
  assert.equal((await call('/api/mcp/blender/some-token')).status, 200, 'Blender 工具也是 CLI 拿随机地址调')
  assert.equal((await call('/api/tasks')).status, 401)
})

test('令牌核对：完全一致才通过，长度不同、空的、差一位的都不通过', () => {
  const tk = accessToken()
  assert.equal(tokenMatches(tk), true)
  assert.equal(tokenMatches(undefined), false)
  assert.equal(tokenMatches(''), false)
  assert.equal(tokenMatches(tk.slice(0, -1)), false)
  assert.equal(tokenMatches(`${tk.slice(0, -1)}${tk.endsWith('0') ? '1' : '0'}`), false)
})

test('Cookie 里带对的令牌放行，错的令牌拒绝', async () => {
  const app = new Hono()
  app.use('*', tokenGuard)
  app.all('*', (c) => c.text('ok'))
  const call = (cookie: string) =>
    app.request('http://127.0.0.1:8787/api/tasks', {
      headers: { host: '127.0.0.1:8787', cookie: `agent_panel_token=${cookie}` },
    })
  assert.equal((await call(accessToken())).status, 200)
  assert.equal((await call('wrong')).status, 401)
})
