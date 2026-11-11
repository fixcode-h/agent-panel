/** Agent 读写表格：按字段查、按主键改、末尾加行、删行，找不到的主键 / 字段直接报错 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TableEditInput, TableQueryInput, planEdit, queryRows } from './table-agent.ts'

const header = { start: 0, roles: ['type', 'name'] as ('type' | 'name')[] }
const rows = [
  ['uint32', 'string', 'uint32'],
  ['ID', 'Name', 'Level'],
  ['1', '木剑', '1'],
  ['2', '铁剑', '5'],
  ['3', '木盾', '2'],
  [],
]
const q = (x: object) => TableQueryInput.parse({ path: 'a.xlsx', ...x })
const e = (x: object) => TableEditInput.parse({ path: 'a.xlsx', ...x })

test('按字段查：完全相同和 ~ 包含，只返回要的字段', () => {
  const r = queryRows(rows, header, 'ID', q({ where: { Name: '~木' }, fields: ['ID', 'Name'] }))
  assert.equal(r.key, 'ID')
  assert.equal(r.total, 2)
  assert.deepEqual(r.rows, [
    { row: 3, values: { ID: '1', Name: '木剑' } },
    { row: 5, values: { ID: '3', Name: '木盾' } },
  ])
  assert.equal(queryRows(rows, header, 'ID', q({ where: { Level: '5' } })).rows[0].values.Name, '铁剑')
  assert.throws(() => queryRows(rows, header, 'ID', q({ where: { Nope: '1' } })), /没有字段「Nope」/)
})

test('改、删、加：删按删之前的行号定，加在最后一行有内容的后面', () => {
  const p = planEdit(
    rows,
    header,
    'ID',
    'S',
    e({ set: [{ key: '3', values: { Level: '9' } }], remove: ['1'], add: [{ ID: '4', Name: '铁盾' }] }),
  )
  assert.deepEqual(p.edit.rows, [
    { at: 2, n: -1 },
    { at: 4, n: 1 },
  ])
  assert.deepEqual(p.after.slice(2, 5), [
    ['2', '铁剑', '5'],
    ['3', '木盾', '9'],
    ['4', '铁盾'],
  ])
  assert.equal(p.removed, 1)
})

test('找不到的主键、表头行、同时改又删都报错', () => {
  assert.throws(() => planEdit(rows, header, 'ID', 'S', e({ set: [{ key: '9', values: { Level: '1' } }] })), /不存在/)
  assert.throws(() => planEdit(rows, header, 'ID', 'S', e({ remove: [2] })), /不是数据行/)
  assert.throws(
    () => planEdit(rows, header, 'ID', 'S', e({ set: [{ key: '1', values: { Level: '1' } }], remove: ['1'] })),
    /又要删/,
  )
  // 按行号改
  const p = planEdit(rows, header, '', 'S', e({ set: [{ row: 4, values: { Name: '钢剑' } }] }))
  assert.deepEqual(p.touched, [{ r: 3, c: 1, v: '钢剑' }])
})
