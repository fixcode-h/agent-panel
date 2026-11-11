/** 格子级差异：按主键对齐、按内容对齐、列按字段名对齐、表头变化、只看变化的折叠 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffSheet, foldSame } from './sheet-diff.ts'

const side = (rows: string[][]) => ({ rows, from: 2, names: rows[1] })
const old = [
  ['uint32', 'string', 'uint32'],
  ['ID', 'Name', 'Lv'],
  ['1', '木剑', '1'],
  ['2', '铁剑', '5'],
  ['3', '木盾', '2'],
]

test('按主键对齐：中间插一行只算新增，改了的只标那一格', () => {
  const now = [
    ['uint32', 'string', 'uint32'],
    ['ID', 'Name', 'Lv'],
    ['1', '木剑', '1'],
    ['9', '新剑', '3'],
    ['2', '铁剑', '6'],
    ['3', '木盾', '2'],
  ]
  const d = diffSheet(side(old), side(now), 'ID')
  assert.equal(d.key, 'ID')
  assert.deepEqual(
    d.rows.map((r) => `${r.kind}:${r.a ?? '-'}:${r.b ?? '-'}:${(r.cols ?? []).join(',')}`),
    ['same:2:2:', 'add:-:3:', 'mod:3:4:2', 'same:4:5:'],
  )
  assert.deepEqual(d.stats, { mod: 1, add: 1, del: 0, cells: 1 })
})

test('删行：放在原来的位置；列换了顺序也按字段名对齐，不算改', () => {
  const now = [
    ['string', 'uint32', 'uint32'],
    ['Name', 'ID', 'Lv'],
    ['木剑', '1', '1'],
    ['木盾', '3', '2'],
  ]
  const d = diffSheet(side(old), side(now), 'ID')
  assert.deepEqual(
    d.rows.map((r) => r.kind),
    ['same', 'del', 'same'],
  )
  assert.equal(d.rows[1].a, 3)
  assert.deepEqual(d.addedCols, [])
  assert.deepEqual(d.headerChanged, [])
})

test('没有主键：按行内容对齐，同一段里删了又加的配成改', () => {
  const a = {
    rows: [
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ],
    from: 0,
  }
  const b = {
    rows: [
      ['a', '1'],
      ['b', '9'],
      ['c', '3'],
      ['d', '4'],
    ],
    from: 0,
  }
  const d = diffSheet(a, b)
  assert.equal(d.key, '')
  assert.deepEqual(
    d.rows.map((r) => `${r.kind}:${(r.cols ?? []).join(',')}`),
    ['same:', 'mod:1', 'same:', 'add:'],
  )
})

test('加列、删列、类型变了都单独列出', () => {
  const now = [
    ['uint32', 'bytes', 'uint32'],
    ['ID', 'Name', 'Price'],
    ['1', '木剑', '10'],
  ]
  const d = diffSheet(side(old.slice(0, 3)), side(now), 'ID')
  assert.deepEqual(d.addedCols, ['Price'])
  assert.deepEqual(d.removedCols, ['Lv'])
  assert.deepEqual(d.headerChanged, ['Name'])
  assert.deepEqual(d.rows[0].cols, [2])
})

test('主键重复时退回按内容对齐', () => {
  const dup = [...old, ['3', '重复', '1']]
  assert.equal(diffSheet(side(old), side(dup), 'ID').key, '')
})

test('只看变化：没变的折成一段，前后各留一行', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    kind: (i === 5 ? 'mod' : 'same') as 'mod' | 'same',
    a: i,
    b: i,
  }))
  const f = foldSame(rows)
  assert.deepEqual(
    f.map((x) => ('fold' in x ? `fold${x.count}` : x.row.kind)),
    ['fold4', 'same', 'mod', 'same', 'fold3'],
  )
})

test('拷到另一边：改过的只写不一样的格子，新行加在最后，按字段名对齐列', async () => {
  const { copyRows } = await import('./sheet-diff.ts')
  const target = [['ID', 'Lv', 'Name'], ['1', '1', '木剑'], ['2', '5', '铁剑'], []]
  const source = [
    ['ID', 'Name', 'Lv'],
    ['1', '木剑', '2'],
    ['2', '铁剑', '5'],
    ['3', '木盾', '1'],
  ]
  const s = (rows: string[][]) => ({ rows, from: 1, names: rows[0] })
  const d = diffSheet(s(target), s(source), 'ID')
  const r = copyRows(
    target,
    source,
    d,
    d.rows.filter((x) => x.kind !== 'same'),
    'S',
  )
  assert.deepEqual(r.edit.rows, [{ at: 3, n: 1 }])
  assert.deepEqual(r.edit.cells, [
    { r: 1, c: 1, v: '2' },
    { r: 3, c: 0, v: '3' },
    { r: 3, c: 2, v: '木盾' },
    { r: 3, c: 1, v: '1' },
  ])
  assert.deepEqual(r.dropped, [])
})
