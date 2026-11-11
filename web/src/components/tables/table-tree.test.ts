/** 表格页的文件树：按目录分层、目录在前、数字按大小排、名字搜索只留命中的 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TableFile } from '@shared/tables'
import { buildTableTree, nameHit } from './table-tree'

const f = (p: string): TableFile => ({ path: p, kind: 'xlsx', size: 1, mtime: '' })
const FILES = ['Config/Item10.xlsx', 'Config/Item2.xlsx', 'Config/Enum/E.xlsx', 'Other/x.xlsx'].map(f)

test('按目录分层，目录在前，文件名里的数字按大小排；目录记文件数', () => {
  const tree = buildTableTree(FILES)
  assert.deepEqual(
    tree.map((n) => `${n.name}:${n.count}`),
    ['Config:3', 'Other:1'],
  )
  assert.deepEqual(
    tree[0].children.map((n) => n.name),
    ['Enum', 'Item2.xlsx', 'Item10.xlsx'],
  )
  assert.equal(tree[0].children[1].file?.path, 'Config/Item2.xlsx')
})

test('名字搜索：几个词都要出现，不分大小写', () => {
  assert.ok(nameHit('Config/Item10.xlsx', 'config item'))
  assert.ok(!nameHit('Config/Item10.xlsx', 'item enum'))
  const tree = buildTableTree(FILES, 'e.xlsx')
  assert.deepEqual(
    tree.map((n) => n.name),
    ['Config/Enum'],
  )
  assert.equal(tree[0].children[0].path, 'Config/Enum/E.xlsx')
})

test('项目目录外的表格目录：开头一串单个子目录并成一个节点', () => {
  const f = (path: string) => ({ path, kind: 'xlsx' as const, size: 1, mtime: '' })
  const tree = buildTableTree([
    f('F:/Game/Designer/Excel/a.xlsx'),
    f('F:/Game/Designer/Excel/sub/b.xlsx'),
    f('Config/c.csv'),
  ])
  assert.deepEqual(
    tree.map((n) => [n.name, n.path, n.count]),
    [
      ['Config', 'Config', 1],
      ['F:/Game/Designer/Excel', 'F:/Game/Designer/Excel', 2],
    ],
  )
  const posix = buildTableTree([f('/data/excel/a.xlsx'), f('/data/excel/b.xlsx')])
  assert.equal(posix[0].name, '/data/excel')
})
