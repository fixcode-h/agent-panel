import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importEdit, importPlan, sheetJson } from './table-io.ts'
import type { ColInfo } from './table-struct.ts'

const info = (col: number, field: string, kind: ColInfo['kind'], list = false): ColInfo =>
  ({ col, field, kind, list, sep: ';', remark: false, type: '', head: [] }) as unknown as ColInfo
const infos = [info(0, 'ID', 'int'), info(1, 'Name', 'string'), info(2, 'Tags', 'int', true)]
const rows = [
  ['ID', 'Name', 'Tags'],
  ['1', 'a', '1;2'],
  ['2', 'b', ''],
]

test('sheetJson 按字段名出对象，数字和数组列按类型转', () => {
  assert.deepEqual(JSON.parse(sheetJson(rows, 1, infos)), [
    { ID: 1, Name: 'a', Tags: [1, 2] },
    { ID: 2, Name: 'b', Tags: [] },
  ])
})

test('importPlan 第一行是字段名就按名字对列，主键已有的更新、新的追加', () => {
  const p = importPlan(rows, 1, infos, 0, 'Name,ID,Extra\nB,2,x\nc,3,y\na,1,z\n', true)
  assert.equal(p.byName, true)
  assert.deepEqual(p.unknown, ['Extra'])
  assert.deepEqual(p.cells, [{ r: 2, c: 1, v: 'B' }])
  assert.equal(p.same, 1)
  assert.deepEqual(p.add, [['3', 'c', '']])
  const e = importEdit(rows.length, p)
  assert.deepEqual(e.op, { at: 3, n: 1 })
  assert.deepEqual(e.cells, [
    { r: 2, c: 1, v: 'B' },
    { r: 3, c: 0, v: '3' },
    { r: 3, c: 1, v: 'c' },
  ])
})

test('importPlan 没有表头时按位置，不更新就全部追加（制表符也认）', () => {
  const p = importPlan(rows, 1, infos, 0, '1\tz\n9\ty', false)
  assert.equal(p.byName, false)
  assert.deepEqual(p.add, [
    ['1', 'z', ''],
    ['9', 'y', ''],
  ])
})
