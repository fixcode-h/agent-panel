import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectDayBuckets } from './project-day-buckets'

test('项目对话按今天和前两天各一组，更早的并成一组，组内顺序不变；只有今天写「今天」，前两天写日期', () => {
  const now = new Date(2026, 10, 16, 10, 0)
  const at = (d: number, h = 9) => new Date(2026, 10, 16 - d, h).toISOString()
  const list = [at(0), at(0, 1), at(1), at(2), at(3), at(40)]
  const b = projectDayBuckets(list, (x) => x, now)
  assert.deepEqual(
    b.map((g) => [g.key, g.items.length]),
    [
      ['today', 2],
      ['yesterday', 1],
      ['dayBefore', 1],
      ['older', 2],
    ],
  )
  assert.deepEqual(b[3].items, [at(3), at(40)])
  assert.deepEqual(
    b.map((g) => g.label),
    ['今天', '11月15日', '11月14日', '更早'],
  )
})

test('没有对话的日期不列；时间在未来的算今天', () => {
  const now = new Date(2026, 10, 16, 10, 0)
  const b = projectDayBuckets([new Date(2026, 10, 17).toISOString(), new Date(2026, 9, 1).toISOString()], (x) => x, now)
  assert.deepEqual(
    b.map((g) => g.key),
    ['today', 'older'],
  )
})
