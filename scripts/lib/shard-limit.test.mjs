import assert from 'node:assert/strict'
import test from 'node:test'
import { shardLimit } from './shard-limit.mjs'

test('并发上限：默认按传进来的上限，不超过分片数', () => {
  assert.equal(shardLimit(12, undefined, 4), 4)
  assert.equal(shardLimit(3, undefined, 4), 3, '分片比上限少时全跑')
  assert.equal(shardLimit(1, undefined, 4), 1)
})

test('并发上限：环境变量可以覆盖，也要落在 1 到分片数之间', () => {
  assert.equal(shardLimit(12, '2', 4), 2)
  assert.equal(shardLimit(12, 8, 4), 8)
  assert.equal(shardLimit(12, '100', 4), 12, '写的比总分片多也只开到分片数')
  assert.equal(shardLimit(12, '2.9', 4), 2, '取整，不按小数开 worker')
})

test('并发上限：非法值按默认处理，不能一个分片都不跑', () => {
  for (const value of ['', '0', '-1', 'abc', null, NaN]) assert.equal(shardLimit(12, value, 4), 4, String(value))
})
