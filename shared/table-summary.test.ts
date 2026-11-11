/** 提交说明的改动小结：按字段数改了几格、加删几行，多张工作表分段 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffSheet } from './sheet-diff.ts'
import { changeSummary } from './table-summary.ts'

const names = ['ID', 'Name', 'Level']
const a = { rows: [names, ['1', 'a', '1'], ['2', 'b', '1'], ['3', 'c', '1']], from: 1, names }
const b = { rows: [names, ['1', 'A', '2'], ['2', 'B', '1'], ['3', 'c', '1'], ['4', 'd', '1']], from: 1, names }

test('改了几格按字段数、加删几行；没改的工作表不写', () => {
  const d = diffSheet(a, b, 'ID')
  assert.equal(
    changeSummary('data/C_Item.xlsx', [{ sheet: 'S', diff: d, names }]),
    'C_Item：改 3 格（Name ×2、Level ×1），加 1 行',
  )
  const same = diffSheet(a, a, 'ID')
  assert.equal(
    changeSummary('data/C_Item.xlsx', [
      { sheet: 'S', diff: d, names },
      { sheet: 'T', diff: same, names },
    ]),
    'C_Item：\n- S：改 3 格（Name ×2、Level ×1），加 1 行',
  )
  assert.equal(changeSummary('x.csv', [{ sheet: 'S', diff: same, names }]), '')
})
