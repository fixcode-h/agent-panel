import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateModelCatalog, parseModelCatalog } from './model-catalog.ts'

const entry = (over: Record<string, unknown> = {}) => ({
  vendor: 'deepseek',
  id: 'deepseek-v4-pro',
  context: 1_000_000,
  maxOutput: 128_000,
  protocols: ['openai-chat'],
  ...over,
})

test('旧补充目录里的 Gemini 协议读之前清掉：整份不能失效，单条坏记录也不影响其它记录', () => {
  const raw = {
    models: [
      entry({ vendor: 'google', id: 'gemini-3-pro', protocols: ['gemini'] }),
      entry({ id: 'relay-model', protocols: ['gemini', 'openai-chat'] }),
      entry(),
    ],
  }
  assert.equal(migrateModelCatalog(raw), true)
  // 只有 gemini 的条目整个删除；还有别的协议的保留并去掉 gemini
  assert.deepEqual(
    raw.models.map((m) => m.id),
    ['relay-model', 'deepseek-v4-pro'],
  )
  assert.deepEqual(raw.models[0].protocols, ['openai-chat'])
  // 协议枚举里已经没有 gemini：清完必须能按现在的结构读出来
  assert.deepEqual(
    parseModelCatalog(raw).map((m) => m.id),
    ['relay-model', 'deepseek-v4-pro'],
  )

  // 幂等；没有 Gemini 条目的目录不动
  const before = structuredClone(raw)
  assert.equal(migrateModelCatalog(raw), false)
  assert.deepEqual(raw, before)

  // 一条手动改坏的记录不能让它前面的记录一起读不出来（保存时也不能被空列表覆盖）
  const bad = {
    models: [entry(), { vendor: '', id: 'bad', context: 0, maxOutput: 0 }, entry({ id: 'deepseek-v4-flash' })],
  }
  assert.deepEqual(
    parseModelCatalog(bad).map((m) => m.id),
    ['deepseek-v4-pro', 'deepseek-v4-flash'],
  )
  assert.deepEqual(parseModelCatalog(null), [])
  assert.deepEqual(parseModelCatalog({}), [])
})
