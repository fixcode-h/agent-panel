import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellChanges, cellIn } from './table-blame.ts'
import { emptySchema } from './tables.ts'

const schema = emptySchema()
const sheet = (rows: string[][]) => [{ name: 'Sheet1', rows }]

test('cellIn 按主键找同一行、按字段名找同一列', () => {
  const head = [
    ['ID', 'Name', 'HP'],
    ['int', 'string', 'int'],
    ['编号', '名字', '血量'],
  ]
  const v1 = sheet([...head, ['1', 'a', '10'], ['2', 'b', '20']])
  // 插了一行、换了列顺序：仍然找得到
  const v2 = sheet([
    ['ID', 'HP', 'Name'],
    ['int', 'int', 'string'],
    ['编号', '血量', '名字'],
    ['3', '5', 'c'],
    ['2', '25', 'b'],
  ])
  const at = { sheet: 'Sheet1', field: 'HP', keyField: 'ID', key: '2', row: 4 }
  assert.equal(cellIn(schema, 'a.xlsx', v1, at), '20')
  assert.equal(cellIn(schema, 'a.xlsx', v2, at), '25')
  assert.equal(cellIn(schema, 'a.xlsx', v2, { ...at, key: '9' }), null)
  assert.equal(cellIn(schema, 'a.xlsx', v2, { ...at, field: 'MP' }), null)
})

test('cellChanges 只留值变了的版本，最老一版有值算新增', () => {
  const ch = cellChanges(['r4', 'r3', 'r2', 'r1'], ['3', '2', '2', '1'])
  assert.deepEqual(
    ch.map((c) => [c.rev, c.from, c.to]),
    [
      ['r4', '2', '3'],
      ['r2', '1', '2'],
      ['r1', null, '1'],
    ],
  )
  assert.deepEqual(cellChanges(['r2', 'r1'], ['x', null]), [{ rev: 'r2', from: null, to: 'x' }])
})
