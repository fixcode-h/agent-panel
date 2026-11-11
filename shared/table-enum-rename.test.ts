/** 枚举值改名：找出改了名的值，替换单值列和数组列里的旧名字，别的列不动 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TableSchema } from './tables.ts'
import { enumRenameCells, findEnumRenames } from './table-enum-rename.ts'

const schema = TableSchema.parse({
  style: { listSep: ';' },
  enums: { Size: { values: [{ name: 'Small' }, { name: 'Big' }] } },
})

test('找改名：同一位置名字变了；只是挪了位置不算', () => {
  const after = { Size: { values: [{ name: 'Tiny' }, { name: 'Big' }] } }
  assert.deepEqual(findEnumRenames(schema.enums, after), [{ enum: 'Size', from: 'Small', to: 'Tiny' }])
  const swapped = { Size: { values: [{ name: 'Big' }, { name: 'Small' }] } }
  assert.deepEqual(findEnumRenames(schema.enums, swapped), [])
})

test('替换：单值列整格比，数组列逐项比，别的列和表头不动', () => {
  const sheet = {
    name: 'S',
    rows: [
      ['uint32', 'Size', 'Size[]', 'string'],
      ['ID', 'A', 'B', 'Note'],
      ['1', 'Small', 'Small;Big; Small', 'Small'],
      ['2', 'Big', '', 'x'],
    ],
  }
  const cells = enumRenameCells(schema, 'a.xlsx', sheet, [{ enum: 'Size', from: 'Small', to: 'Tiny' }])
  assert.deepEqual(cells, [
    { r: 2, c: 1, v: 'Tiny' },
    { r: 2, c: 2, v: 'Tiny;Big; Tiny' },
  ])
})
