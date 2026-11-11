import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSheets, opsFor } from './table-merge.ts'
import { applyRowOps, changedCells } from './table-edit.ts'
import { emptySchema } from './tables.ts'

const schema = emptySchema()
const head = [
  ['ID', 'Name', 'HP'],
  ['int', 'string', 'int'],
  ['编号', '名字', '血量'],
]
const book = (...rows: string[][]) => [{ name: 'S', rows: [...head, ...rows] }]

test('opsFor 算出把 ours 变成目标顺序的行操作', () => {
  // ours 0..4，目标：0、新、2、4、新
  const ops = opsFor(5, [0, -1, 2, 4, -1])
  const rows = applyRowOps([['a'], ['b'], ['c'], ['d'], ['e']], ops)
  assert.deepEqual(rows, [['a'], [], ['c'], ['e'], []])
})

test('一边改的自动合，两边改同一格算冲突，选哪边用哪边', () => {
  const base = book(['1', 'a', '10'], ['2', 'b', '20'], ['3', 'c', '30'])
  // 我：改了 1 的血量、删了 3、加了 4
  const ours = book(['1', 'a', '11'], ['2', 'b', '20'], ['4', 'd', '40'])
  // 对方：改了 2 的名字、1 的血量改成别的、加了 5（在 2 后面）
  const theirs = book(['1', 'a', '12'], ['2', 'B', '20'], ['5', 'e', '50'], ['3', 'c', '30'])
  const r = mergeSheets(schema, 'x.xlsx', base, ours, theirs)
  assert.deepEqual(
    r.conflicts.map((c) => [c.kind, c.key, c.field, c.ours, c.theirs]),
    [['cell', '1', 'HP', '11', '12']],
  )
  const s = r.sheets[0]
  assert.deepEqual(s.rows.slice(3), [
    ['1', 'a', '11'],
    ['2', 'B', '20'],
    ['5', 'e', '50'],
    ['4', 'd', '40'],
  ])
  // 行操作 + 改的格子做在 ours 上，得到的正好是合并结果
  const after = applyRowOps(ours[0].rows, s.ops)
  for (const { r: y, c, v } of changedCells(ours[0].rows, s.ops, s.rows)) {
    while (after[y].length <= c) after[y].push('')
    after[y][c] = v
  }
  assert.deepEqual(
    after.map((x) => x.filter(Boolean)),
    s.rows.map((x) => x.filter(Boolean)),
  )
  const pick = mergeSheets(schema, 'x.xlsx', base, ours, theirs, { [r.conflicts[0].id]: 'theirs' })
  assert.deepEqual(pick.sheets[0].rows[3], ['1', 'a', '12'])
  assert.equal(pick.conflicts.length, 1)
})

test('一边删了一行、另一边改了这一行：行冲突', () => {
  const base = book(['1', 'a', '10'], ['2', 'b', '20'])
  const ours = book(['1', 'a', '10'])
  const theirs = book(['1', 'a', '10'], ['2', 'b', '25'])
  const r = mergeSheets(schema, 'x.xlsx', base, ours, theirs)
  assert.equal(r.conflicts[0].kind, 'row')
  assert.equal(r.sheets[0].rows.length, 4)
  const keep = mergeSheets(schema, 'x.xlsx', base, ours, theirs, { [r.conflicts[0].id]: 'theirs' })
  assert.deepEqual(keep.sheets[0].rows[4], ['2', 'b', '25'])
})
