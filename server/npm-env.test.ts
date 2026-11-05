import { test } from 'node:test'
import assert from 'node:assert/strict'
import { npmProxyEnv } from './npm-env.ts'

const REG = 'https://registry.npmjs.org/'

// 用户报的问题：开着系统代理 / 面板里填了代理，npm 子进程仍然直连，安装很慢（2026-11-04）
test('npm 代理：系统代理和设置里的代理写进 HTTPS_PROXY 交给 npm', () => {
  const r = npmProxyEnv(
    { https_proxy: '' },
    { kind: 'proxy', key: 'http://127.0.0.1:7890', shown: 'http://127.0.0.1:7890', system: true },
    REG,
    true,
  )
  assert.equal(r.env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(r.env.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal('https_proxy' in r.env, false)
  assert.match(r.note ?? '', /127\.0\.0\.1:7890/)
})

test('npm 代理：代理连不上时不交给 npm，并在输出里说明直连', () => {
  const r = npmProxyEnv({}, { kind: 'proxy', key: 'http://127.0.0.1:7890', shown: 'x', system: true }, REG, false)
  assert.equal(r.env.HTTPS_PROXY, undefined)
  assert.ok(r.note)
})

test('npm 代理：直连或代理本来就来自环境变量时不改环境', () => {
  const base = { HTTPS_PROXY: 'http://p:1' }
  assert.equal(npmProxyEnv(base, { kind: 'direct', fallback: true }, REG, true).env, base)
  assert.equal(npmProxyEnv(base, { kind: 'proxy', key: 'http://p:1', shown: 'http://p:1' }, REG, true).env, base)
})
