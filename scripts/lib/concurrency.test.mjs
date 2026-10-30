import assert from 'node:assert/strict'
import test from 'node:test'
import { suggestConcurrency } from './concurrency.mjs'

const G = 1024 ** 3
const base = { kind: 'e2e', envName: 'X', cpus: 8, memoryBytes: 16 * G, units: 14 }

test('并发：CPU、内存、单元数取小，并写明是哪一项定的', () => {
  assert.deepEqual([suggestConcurrency(base).value, suggestConcurrency(base).source], [8, 'cpu'])
  // 内存只够两个分片（2G × 0.7 / 600M = 2）
  const tight = suggestConcurrency({ ...base, memoryBytes: 2 * G })
  assert.equal(tight.value, 2)
  assert.equal(tight.source, 'memory')
  assert.equal(suggestConcurrency({ ...base, units: 3 }).value, 3)
  // 单测按核数超开
  assert.equal(suggestConcurrency({ ...base, kind: 'unit', units: 300, cpuFactor: 1.5 }).value, 12)
})

test('环境变量：cap 模式只能往下压，写大了不生效并说明；override 模式照它开', () => {
  assert.equal(suggestConcurrency({ ...base, env: '1' }).value, 1)
  assert.equal(suggestConcurrency({ ...base, env: '1' }).source, 'env')
  const big = suggestConcurrency({ ...base, env: '99', memoryBytes: 2 * G })
  assert.equal(big.value, 2)
  assert.match(big.note, /X=99 只作上限，没用上/)
  const over = suggestConcurrency({
    ...base,
    kind: 'unit',
    units: 300,
    env: '40',
    mode: 'override',
    memoryBytes: 1 * G,
  })
  assert.equal(over.value, 40)
  assert.equal(over.source, 'env')
})

test('环境变量的非法值（空、0、负数、非数字）按没写处理，至少开一个', () => {
  for (const env of ['', '0', '-1', 'abc', null, undefined, NaN])
    assert.equal(suggestConcurrency({ ...base, env }).value, 8, String(env))
  assert.equal(suggestConcurrency({ ...base, memoryBytes: 0 }).value, 1)
})

test('默认上限（e2e 的 4）和 CPU、内存一起取小', () => {
  assert.equal(suggestConcurrency({ ...base, defaultCap: 4 }).value, 4)
  assert.equal(suggestConcurrency({ ...base, defaultCap: 4, units: 2 }).value, 2)
})
