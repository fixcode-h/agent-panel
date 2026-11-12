import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceCost } from './price.ts'
import { ModelCatalogEntry } from './catalog.ts'

test('CLI 不报费用时按填的单价折算：每百万 token 的价 × 用量', () => {
  const price = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }
  const cost = priceCost(price, { addInput: 1_000_000, addOutput: 500_000, addCacheRead: 2_000_000 })
  assert.equal(cost, 2 + 4 + 1)
})

test('没填单价：费用记 0（界面写费用未知），不瞎估', () => {
  assert.equal(priceCost(undefined, { addInput: 1_000_000, addOutput: 1_000_000 }), 0)
})

test('模型目录的单价可以不填；填了缓存价可以省', () => {
  const base = { vendor: 'openai', id: 'm', context: 1000, maxOutput: 100 }
  assert.equal(ModelCatalogEntry.parse(base).price, undefined)
  assert.deepEqual(ModelCatalogEntry.parse({ ...base, price: { input: 1, output: 2 } }).price, {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  })
})
