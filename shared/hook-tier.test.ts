/**
 * 内置钩子的档位（借鉴 ECC 的钩子档位）：标准档就是原来的默认值，开关按「项目单设 → 项目档位 → 全局单设 → 全局档位」取。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_HOOKS, HooksData, builtinOn, tierChanged, tierOn } from './hook-defs.ts'

const hook = (id: string) => BUILTIN_HOOKS.find((h) => h.id === id)!

test('档位：标准档的开关就是默认值；精简是标准的子集，严格全开', () => {
  for (const h of BUILTIN_HOOKS) assert.equal(tierOn('standard', h), h.defaultOn, h.id)
  for (const h of BUILTIN_HOOKS) if (tierOn('minimal', h)) assert.ok(tierOn('standard', h), h.id)
  assert.ok(BUILTIN_HOOKS.every((h) => tierOn('strict', h)))
  // 关掉会出错、闯祸的守卫在精简档也开着
  for (const id of ['keep-going', 'danger-guard', 'secret-guard', 'push-guard'])
    assert.ok(tierOn('minimal', hook(id)), id)
  // 新加的两个守卫只在严格档
  for (const id of ['read-before-edit', 'check-config-guard']) assert.equal(hook(id).tier, 'strict')
})

test('档位：旧数据没有档位字段时按标准，行为不变', () => {
  const old = HooksData.parse({ builtins: { 'loop-hint': true } })
  assert.equal(old.tier, 'standard')
  assert.deepEqual(old.projectTiers, {})
  assert.equal(builtinOn(old, hook('loop-hint')), true)
  assert.equal(builtinOn(old, hook('plan-pace')), true)
  assert.equal(builtinOn(old, hook('verify-before-end')), false)
})

test('档位：四层取法，项目选了档位就不带全局逐个改的', () => {
  const data = HooksData.parse({
    tier: 'minimal',
    builtins: { 'plan-pace': true },
    projectTiers: { p2: 'strict' },
    projects: { p1: { 'danger-guard': false }, p2: { 'loop-hint': false } },
  })
  // 全局：精简档，plan-pace 单独开着
  assert.equal(builtinOn(data, hook('plan-pace')), true)
  assert.equal(builtinOn(data, hook('big-read-guard')), false)
  // 没选档位的项目跟全局，自己单设的优先
  assert.equal(builtinOn(data, hook('plan-pace'), 'p1'), true)
  assert.equal(builtinOn(data, hook('danger-guard'), 'p1'), false)
  // 选了严格的项目：全局单开的 plan-pace 不影响，严格档全开，自己单关的 loop-hint 关着
  assert.equal(builtinOn(data, hook('verify-before-end'), 'p2'), true)
  assert.equal(builtinOn(data, hook('loop-hint'), 'p2'), false)
  // 改过几个：全局 plan-pace（精简档下本来关）1 个；p1 的 danger-guard 1 个；p2 的 loop-hint 1 个
  assert.equal(tierChanged(data), 1)
  assert.equal(tierChanged(data, 'p1'), 1)
  assert.equal(tierChanged(data, 'p2'), 1)
  assert.equal(tierChanged(data, 'p3'), 0)
})
