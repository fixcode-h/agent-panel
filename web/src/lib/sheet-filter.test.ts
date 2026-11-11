/**
 * 表格列筛选和排序：表头行不参与、按值和按条件取交集、数字列按数字排、空格子排最后。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareCells, distinctValues, filterActive, isNumericColumn, visibleRows } from '@/lib/sheet-filter'

const ROWS = [
  ['ID', 'Kind', 'Name'],
  ['3', 'Wall', '挂镜'],
  ['10', 'Floor', '穿衣镜'],
  ['2', 'Wall', ''],
  ['-1', 'Desk', '小镜'],
]

test('没有筛选和排序：表头以下的行按原顺序', () => {
  assert.deepEqual(visibleRows(ROWS, 1, {}, null), [1, 2, 3, 4])
})

test('按值筛选和条件筛选取交集', () => {
  assert.deepEqual(visibleRows(ROWS, 1, { 1: { values: ['Wall'] } }, null), [1, 3])
  assert.deepEqual(visibleRows(ROWS, 1, { 1: { values: ['Wall'] }, 0: { cond: { op: 'gt', a: '2' } } }, null), [1])
  assert.deepEqual(visibleRows(ROWS, 1, { 0: { cond: { op: 'between', a: '5', b: '-5' } } }, null), [1, 3, 4])
  assert.deepEqual(visibleRows(ROWS, 1, { 2: { cond: { op: 'empty' } } }, null), [3])
  assert.deepEqual(visibleRows(ROWS, 1, { 2: { cond: { op: 'contains', a: '镜' } } }, null), [1, 2, 4])
})

test('没填完的条件不起作用', () => {
  assert.equal(filterActive({ cond: { op: 'between', a: '1' } }), false)
  assert.deepEqual(visibleRows(ROWS, 1, { 0: { cond: { op: 'gt', a: '' } } }, null), [1, 2, 3, 4])
})

test('数字列按数字排，降序也稳定', () => {
  assert.deepEqual(visibleRows(ROWS, 1, {}, { col: 0, desc: false }), [4, 3, 1, 2])
  assert.deepEqual(visibleRows(ROWS, 1, {}, { col: 1, desc: true }), [1, 3, 2, 4])
})

test('空格子排在最后，文字里的数字按大小', () => {
  assert.ok(compareCells('', 'a') > 0)
  assert.ok(compareCells('item2', 'item10') < 0)
})

test('去重值按次数排，数字列识别', () => {
  assert.deepEqual(distinctValues(ROWS, 1, 1).list[0], { value: 'Wall', count: 2 })
  assert.equal(isNumericColumn(ROWS, 1, 0), true)
  assert.equal(isNumericColumn(ROWS, 1, 1), false)
})
