/**
 * 插件接口 11 的清单字段（runtime-schema.ts）：env 不许碰凭据和面板变量、PATH 只能前置、页面指的进程要存在。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManifest } from './types.ts'
import { reservedEnv, usesApi11 } from './runtime-schema.ts'

const base = { id: 'demo', name: 'Demo', version: '1.0.0', api: 11 }

test('接口 11：凭据和面板自己的变量不许写', () => {
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'AGENT_PANEL_DATA', 'GITHUB_TOKEN', 'MY_SECRET', 'HOME'])
    assert.ok(reservedEnv(k), k)
  for (const k of ['ARCHIFY_CHROME', 'ARCHIFY_UPDATE_CHECK_DISABLED', 'NODE_ENV']) assert.equal(reservedEnv(k), '', k)
  assert.equal(PluginManifest.safeParse({ ...base, env: { ANTHROPIC_API_KEY: 'x' } }).success, false)
  assert.equal(PluginManifest.safeParse({ ...base, env: { ARCHIFY_CHROME: '{config.chromePath}' } }).success, true)
})

test('接口 11：PATH 只能前置目录，其他变量只能是字符串', () => {
  assert.equal(PluginManifest.safeParse({ ...base, env: { PATH: '/usr/bin' } }).success, false)
  assert.equal(PluginManifest.safeParse({ ...base, env: { FOO: { prepend: ['bin'] } } }).success, false)
  assert.equal(PluginManifest.safeParse({ ...base, env: { PATH: { prepend: ['bin', '.venv/bin'] } } }).success, true)
})

test('接口 11：默认值和是否用到', () => {
  const m = PluginManifest.parse({ ...base, api: 1 })
  assert.deepEqual([m.env, m.mcp, m.services, m.webPages, m.wrap], [{}, [], [], [], undefined])
  assert.equal(usesApi11(m), false)
  const full = PluginManifest.parse({
    ...base,
    mcp: [{ name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.41'] }],
    services: [{ id: 'app', command: 'node', args: ['server.js', '--port', '{port}'] }],
    webPages: [{ id: 'app', label: 'App', url: 'service:app/' }],
    wrap: { repo: 'tt-a1i/archify', commit: 'e378488', kinds: ['skills', 'cli'] },
  })
  assert.equal(full.services[0].port, 'auto')
  assert.equal(full.services[0].stopAfterIdleMin, 30)
  assert.equal(full.wrap?.track, 'release')
  assert.equal(usesApi11(full), true)
  assert.equal(
    PluginManifest.safeParse({ ...base, webPages: [{ id: 'x', label: 'X', url: 'javascript:1' }] }).success,
    false,
  )
})
