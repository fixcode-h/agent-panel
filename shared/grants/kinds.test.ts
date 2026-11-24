/** 授权类型注册表：规则键归类、卡上给不给「本对话不再询问」。运行：npm run test:unit */
import assert from 'node:assert/strict'
import test from 'node:test'
import { gateRule, grantKindOf, grantKinds, rememberOn } from './kinds.ts'

test('规则键按前缀归类，用户钩子合成一类', () => {
  assert.equal(grantKindOf('command:git status'), 'command')
  assert.equal(grantKindOf('file:src/'), 'file')
  assert.equal(grantKindOf('plugin:feishu:doc-read:abc'), 'plugin')
  assert.equal(grantKindOf(gateRule('read-only-guard')), 'gate:read-only-guard')
  assert.equal(grantKindOf(gateRule('hook:不许跑测试')), 'gate:hook')
  assert.equal(gateRule(' '), '')
})

test('默认都给，删库和凭据两个门禁默认不给；设置里改过的按设置', () => {
  assert.equal(rememberOn('gate:read-only-guard', {}), true)
  assert.equal(rememberOn('gate:danger-guard', {}), false)
  assert.equal(rememberOn('gate:secret-guard', undefined), false)
  assert.equal(rememberOn('gate:danger-guard', { 'gate:danger-guard': true }), true)
  assert.equal(rememberOn('command:npm test', { command: false }), false)
  assert.equal(rememberOn(undefined, {}), false)
  // 不认识的类型（以后加的）默认给
  assert.equal(rememberOn('newkind:x', {}), true)
})

test('设置页列表：每种都有名字和说明，id 不重复，门禁类包含只读守卫', () => {
  const ks = grantKinds()
  assert.equal(new Set(ks.map((k) => k.id)).size, ks.length)
  assert.ok(ks.some((k) => k.id === 'gate:read-only-guard'))
  for (const k of ks) assert.ok(k.name() && k.scope())
})
