import assert from 'node:assert/strict'
import test from 'node:test'
import { groupByDay } from '../shared/task.ts'

/** 固定的「现在」：本地时间 2026-10-20 10:00 */
const now = new Date(2026, 9, 20, 10, 0, 0)
const item = (id: string, y: number, m: number, d: number, h = 9, min = 0) => ({
  id,
  at: new Date(y, m - 1, d, h, min).toISOString(),
})
const shape = (list: { id: string; at: string }[]) =>
  groupByDay(list, (x) => x.at, now).map((g) => [g.label, g.items.map((x) => x.id)])

test('任务按自然日分组：今天、昨天，更早的写日期，新的日期在前', () => {
  const list = [
    item('a', 2026, 10, 20, 9, 51),
    item('b', 2026, 10, 20, 9, 46),
    item('c', 2026, 10, 19, 23, 59),
    item('d', 2026, 10, 19, 0, 1),
    item('e', 2026, 10, 17, 8),
    item('f', 2026, 10, 17, 21),
  ]
  assert.deepEqual(shape(list), [
    ['今天', ['a', 'b']],
    ['昨天', ['c', 'd']],
    ['10月17日', ['e', 'f']],
  ])
})

test('空列表没有分组', () => {
  assert.deepEqual(shape([]), [])
})

test('不是今年的日子带上年份', () => {
  const list = [item('old', 2025, 12, 31)]
  assert.deepEqual(shape(list), [['2025年12月31日', ['old']]])
})
