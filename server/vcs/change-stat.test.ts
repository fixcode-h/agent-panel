/** 操作前后的改动对比：P4 diff -ds 解析、相减、大量删除告警。运行：npm run test:unit */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bigDeletes, changeDelta, changeSummary, parseP4DiffSummary } from './change-stat.ts'

const P4_OUT = [
  '==== //depot/G/Script/DBConfigIntermediate.lua#12 - D:\\P\\Script\\DBConfigIntermediate.lua ====',
  'add 1 chunks 2 lines',
  'deleted 3 chunks 79859 lines',
  'changed 1 chunks 5 / 6 lines',
  '==== //depot/G/Script/DataEnumTypeConfig.lua#3 - D:\\P\\Script\\DataEnumTypeConfig.lua ====',
  'add 2 chunks 12 lines',
  'deleted 0 chunks 0 lines',
  'changed 0 chunks 0 / 0 lines',
].join('\n')

test('p4 diff -ds：changed 的旧行算删、新行算加', () => {
  const s = parseP4DiffSummary(P4_OUT)
  assert.deepEqual(s.get('D:\\P\\Script\\DBConfigIntermediate.lua'), { add: 8, del: 79864 })
  assert.deepEqual(s.get('D:\\P\\Script\\DataEnumTypeConfig.lua'), { add: 12, del: 0 })
})

test('只算这次新增的改动；整份被清空的文件告警', () => {
  const before = new Map([
    ['D:\\P\\Script\\DataEnumTypeConfig.lua', { add: 2, del: 0 }],
    ['D:\\P\\Old.lua', { add: 1, del: 1 }],
  ])
  const d = changeDelta(before, parseP4DiffSummary(P4_OUT))
  assert.deepEqual(d, [
    { file: 'D:\\P\\Script\\DBConfigIntermediate.lua', add: 8, del: 79864 },
    { file: 'D:\\P\\Script\\DataEnumTypeConfig.lua', add: 10, del: 0 },
  ])
  assert.equal(bigDeletes(d).length, 1)
  const text = changeSummary(d)
  assert.match(text, /DBConfigIntermediate\.lua（\+8 −79864）/)
  assert.match(text, /【注意】.*DBConfigIntermediate\.lua 一次删掉了大量内容.*还原它并告诉用户/)
  assert.equal(changeSummary([]), '')
  assert.doesNotMatch(changeSummary([{ file: 'a.lua', add: 600, del: 700 }]), /注意/)
})
