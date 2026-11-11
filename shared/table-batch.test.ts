/** 批量修改：加减乘除跳过不是数字的格子、前后缀、正则、重新编号；只返回变了的格子 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batchEdit } from './table-batch.ts'

const rows = [['10'], ['abc'], [''], ['0.1'], ['7']]
const all = rows.map((_, r) => ({ r, c: 0 }))

test('加减乘除：不是数字、空的跳过，浮点误差收掉；除以 0 不改', () => {
  assert.deepEqual(batchEdit(rows, all, { kind: 'math', fn: '*', n: 3 }), [
    { r: 0, c: 0, v: '30' },
    { r: 3, c: 0, v: '0.3' },
    { r: 4, c: 0, v: '21' },
  ])
  assert.deepEqual(batchEdit(rows, all, { kind: 'math', fn: '/', n: 0 }), [])
})

test('前后缀、正则替换、按顺序重新编号', () => {
  assert.deepEqual(
    batchEdit(rows, all.slice(0, 3), { kind: 'affix', prefix: 'x_', suffix: '' }).map((c) => c.v),
    ['x_10', 'x_abc'],
  )
  assert.deepEqual(
    batchEdit(rows, all, { kind: 'regex', find: '\\d', replace: '#' }).map((c) => c.v),
    ['##', '#.#', '#'],
  )
  assert.deepEqual(
    batchEdit(
      rows,
      [
        { r: 4, c: 0 },
        { r: 0, c: 0 },
      ],
      { kind: 'renumber', start: 100, step: 10 },
    ),
    [
      { r: 4, c: 0, v: '100' },
      { r: 0, c: 0, v: '110' },
    ],
  )
  assert.throws(() => batchEdit(rows, all, { kind: 'regex', find: '(', replace: '' }))
})
