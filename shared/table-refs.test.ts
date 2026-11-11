/** 引用跳转和反向引用：值跳到被引用表的那一行；谁引用了这一行（数组列按分隔符拆开比） */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TableSchema } from './tables.ts'
import type { SheetData } from './files.ts'
import { findBackRefs, findRefTarget, refsTo } from './table-refs.ts'

const roles: SheetData = {
  name: 'Role',
  rows: [
    ['uint32', 'bytes'],
    ['ID', 'Name'],
    ['1001', '艾琳'],
    ['1002', '洛克'],
  ],
}
const config: SheetData = {
  name: 'Config',
  rows: [
    ['optional', 'repeated'],
    ['uint32', 'uint32'],
    ['ID', 'RoleIDs'],
    ['1', '1001;1002'],
    ['2', '1002'],
    ['3', '10021'],
  ],
}
const schema = TableSchema.parse({
  style: { listSep: ';' },
  columns: { 'c.xlsx#*#RoleIDs': { ref: 'r.xlsx#ID' } },
})

test('引用跳转：按字段名找到被引用表里值相等的那一行', () => {
  assert.deepEqual(findRefTarget(schema, 'r.xlsx#ID', '1002', [roles]), { sheet: 'Role', row: 3, col: 0 })
  assert.equal(findRefTarget(schema, 'r.xlsx#ID', '9', [roles]), null)
  assert.equal(findRefTarget(schema, 'r.xlsx#Nope', '1002', [roles]), null)
})

test('反向引用：数组列拆开整项比，不会把 10021 当成 1002', async () => {
  assert.equal(refsTo(schema, 'r.xlsx').length, 1)
  const hits = await findBackRefs(schema, 'r.xlsx', 'Role', { ID: '1002', Name: '洛克' }, async (f) =>
    f === 'c.xlsx' ? [config] : undefined,
  )
  assert.deepEqual(
    hits.map((h) => [h.path, h.row, h.col]),
    [
      ['c.xlsx', 3, 1],
      ['c.xlsx', 4, 1],
    ],
  )
})
