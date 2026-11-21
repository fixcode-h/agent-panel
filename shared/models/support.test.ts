/**
 * 按模型档位加强扶持（C1）：弱档默认全加强、中强档和面板原来一样；只往严里推；设置页改格子的校验。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_HOOKS, builtinOn, tierOn } from '../hooks/builtins.ts'
import { HooksData } from '../hooks/defs.ts'
import { matchModel } from './catalog.ts'
import { ModelSupportData, patchSupport, resolveSupport, supportRecord, supportView } from './support.ts'

test('扶持：弱档默认加强四项，中强档就是面板原来的值，关掉总开关全回原样', () => {
  const data = ModelSupportData.parse({})
  const low = resolveSupport(data, 'low')
  assert.deepEqual(
    { hookTier: low.hookTier, implPlan: low.implPlan, pushItems: low.pushItems, paceCalls: low.paceCalls },
    { hookTier: 'strict', implPlan: 'always', pushItems: 5, paceCalls: 10 },
  )
  assert.deepEqual(low.boosted, ['hookTier', 'implPlan', 'pushItems', 'paceCalls'])
  for (const tier of ['medium', 'high'] as const) assert.deepEqual(resolveSupport(data, tier).boosted, [], tier)
  const off = resolveSupport({ ...data, enabled: false }, 'low')
  assert.deepEqual(off.boosted, [])
  assert.equal(off.hookTier, 'standard')
  assert.equal(supportRecord(off), undefined)
  assert.deepEqual(supportRecord(low)?.boosted[0], { key: 'hookTier', value: 'strict' })
})

test('扶持：旧的 hooks.json 没有这一项时按默认开着', () => {
  const old = HooksData.parse({ builtins: {} })
  assert.equal(old.modelSupport.enabled, true)
  assert.deepEqual(old.modelSupport.values, {})
})

test('扶持：模型目录里 deepseek-flash 是弱档、deepseek-v4-pro 是强档（这张表靠目录的 tier 套用）', () => {
  assert.equal(matchModel('deepseek-v4-flash')?.tier, 'low')
  assert.equal(matchModel('deepseek-v4-pro')?.tier, 'high')
})

test('扶持：钩子档位只在落到全局档位时往严里推，项目选的档位、逐个改过的开关优先', () => {
  const hook = (id: string) => BUILTIN_HOOKS.find((h) => h.id === id)!
  const strictOnly = BUILTIN_HOOKS.find((h) => h.tier === 'strict')!
  const data = HooksData.parse({ projectTiers: { p2: 'minimal' }, builtins: { 'loop-hint': false } })
  // 全局标准档 + 弱模型：严格档的钩子开起来
  assert.equal(builtinOn(data, strictOnly), false)
  assert.equal(builtinOn(data, strictOnly, 'p1', 'strict'), true)
  // 扶持给的档位比全局松时不变松
  const strictGlobal = HooksData.parse({ tier: 'strict' })
  assert.equal(builtinOn(strictGlobal, strictOnly, '', 'minimal'), true)
  // 项目手动选了精简：以项目为准
  assert.equal(builtinOn(data, strictOnly, 'p2', 'strict'), tierOn('minimal', strictOnly))
  // 全局逐个关掉的照旧关着
  assert.equal(builtinOn(data, hook('loop-hint'), 'p1', 'strict'), false)
})

test('扶持：设置页改格子，等于默认就不记，越界报错', () => {
  const data = ModelSupportData.parse({})
  const a = patchSupport(data, { tier: 'medium', key: 'pushItems', value: 6 })
  assert.ok(a.ok)
  assert.deepEqual(a.data.values, { medium: { pushItems: 6 } })
  assert.equal(supportView(a.data).items.find((x) => x.key === 'pushItems')!.values.medium, 6)
  assert.ok(resolveSupport(a.data, 'medium').boosted.includes('pushItems'))
  const back = patchSupport(a.data, { tier: 'medium', key: 'pushItems', value: 3 })
  assert.ok(back.ok)
  assert.deepEqual(back.data.values, {})
  assert.equal(patchSupport(data, { tier: 'low', key: 'paceCalls', value: 0 }).ok, false)
  assert.equal(patchSupport(data, { tier: 'low', key: 'hookTier', value: 'loose' }).ok, false)
  const off = patchSupport(data, { enabled: false })
  assert.ok(off.ok)
  assert.equal(off.data.enabled, false)
})
