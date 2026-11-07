import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 外网专用端口（自建反代方式）：没有登录会话一律挡住，用密码登录后放行。主端口带转发头的情况见 auth-proxy.test.ts
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
    remoteAccess: { enabled: true, mode: 'custom', localPort: free, maxAttempts: 3 },
  }),
  'utf8',
)

const { Hono } = await import('hono')
const { tokenGuard } = await import('./auth.ts')
const { applyRemote, configureRemote, stopRemote } = await import('./remote.ts')

const app = new Hono()
app.use('*', tokenGuard)
app.all('*', (c) => c.text('ok'))
const base = `http://127.0.0.1:${free}`

const login = (password: string, ip = '203.0.113.9', next = '/settings') =>
  fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    // 反代转来的：连接来自本机，访问者地址在 X-Forwarded-For 里
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
    body: new URLSearchParams({ password, next }),
  })

test('外网专用端口：没登录挡住，用初始密码登录后放行，退出后失效', async () => {
  configureRemote(app.fetch)
  await applyRemote()
  try {
    const guard = JSON.parse(readFileSync(path.join(dir, 'guard.json'), 'utf8'))
    assert.match(
      guard.initialPassword,
      /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/,
      '打开外部访问时生成初始密码',
    )
    assert.match(guard.passwordHash, /^scrypt\$/)

    // 反代把 Host 改成 127.0.0.1 也一样当外网
    const api = await fetch(`${base}/api/tasks`)
    assert.equal(api.status, 401)
    assert.equal(((await api.json()) as { login?: string }).login, '/login')
    const page = await fetch(`${base}/projects?x=1`, { redirect: 'manual' })
    assert.equal(page.status, 302)
    assert.equal(page.headers.get('location'), '/login?next=%2Fprojects%3Fx%3D1')
    assert.equal((await fetch(`${base}/login`)).status, 200)
    // 访问令牌在外网不管用：外网只认密码登录
    assert.equal((await fetch(`${base}/api/tasks?token=whatever`)).status, 401)

    assert.equal((await login('wrong-password')).status, 401)
    const ok = await login(guard.initialPassword)
    assert.equal(ok.status, 302)
    assert.equal(ok.headers.get('location'), '/settings')
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0]
    assert.match(cookie, /^agent_panel_session=/)
    assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly/i)
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status, 200)
    assert.equal((await fetch(`${base}/api/remote/guard/session`, { headers: { cookie } })).status, 200)

    await fetch(`${base}/logout`, { headers: { cookie } })
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status, 401, '退出后会话作废')

    // next 只认站内路径
    const evil = await login(guard.initialPassword, '203.0.113.20', '//evil.example.com')
    assert.equal(evil.headers.get('location'), '/')

    // 同一个来源连续输错 3 次（设置里的 maxAttempts）锁定，锁着时密码对了也不放行；别的来源不受影响
    for (let i = 0; i < 3; i++) await login('wrong', '198.51.100.7')
    assert.equal((await login(guard.initialPassword, '198.51.100.7')).status, 429)
    assert.equal((await login(guard.initialPassword, '198.51.100.8')).status, 302)
  } finally {
    await stopRemote()
  }
  // 停掉之后端口不再监听
  await assert.rejects(fetch(`${base}/api/tasks`))
})
