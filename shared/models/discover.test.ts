import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_MODEL_CATALOG, ModelCatalogEntry } from './catalog.ts'
import { newModelCandidates } from './discover.ts'

const entry = (vendor: string, id: string) =>
  ModelCatalogEntry.parse({ vendor, id, context: 1_000_000, maxOutput: 128_000 })

test('联网检查新模型：目录里有的（同 id、只差日期或 preview 后缀、别名）不算新，查到的重复只留一条', () => {
  const r = newModelCandidates(
    [
      entry('openai', 'gpt-6.2-astra'),
      entry('openai', 'GPT-6.2-Astra'),
      entry('deepseek', 'deepseek-v4-flash'),
      entry('bytedance', 'doubao-seed-2-1-pro-260915'),
      entry('baidu', 'ernie-5.5-flash'),
      entry('openai', 'gpt-9-test'),
    ],
    [
      entry('openai', 'gpt-6.2-astra'),
      ModelCatalogEntry.parse({ ...entry('deepseek', 'deepseek-flash'), aliases: ['deepseek-v4-flash'] }),
      entry('bytedance', 'doubao-seed-2-1-pro'),
      entry('baidu', 'ernie-5.5-flash-preview'),
    ],
  )
  assert.deepEqual(
    r.candidates.map((m) => m.id),
    ['gpt-9-test'],
  )
  assert.equal(r.known, 5)
})

test('内置目录没有重复的厂商 + id，查到同一条也认得出', () => {
  const keys = BUILTIN_MODEL_CATALOG.map((m) => `${m.vendor}:${m.id}`)
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(newModelCandidates(BUILTIN_MODEL_CATALOG, BUILTIN_MODEL_CATALOG).candidates.length, 0)
})
