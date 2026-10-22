import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildChangeTree, visibleChangeRows } from './changes-tree'

test('按目录分组：目录排在文件前，目录行是下面所有文件的增删合计', () => {
  const tree = buildChangeTree([
    { path: 'web/src/a.ts', add: 3, del: 1 },
    { path: 'web/src/nested/b.ts', add: 4, del: 2 },
    { path: 'README.md', add: 1, del: 0 },
  ])
  assert.deepEqual(
    tree.map((n) => [n.name, n.dir, n.add, n.del]),
    [
      ['web', true, 7, 3],
      ['README.md', false, 1, 0],
    ],
  )
  const web = tree[0]
  assert.deepEqual(
    web.children.map((n) => [n.name, n.add, n.del]),
    [['src', 7, 3]],
  )
  const src = web.children[0]
  assert.deepEqual(
    src.children.map((n) => [n.name, n.add, n.del]),
    [
      ['nested', 4, 2],
      ['a.ts', 3, 1],
    ],
  )
})

test('没有 / 的路径直接放在根层，反斜杠也按目录拆', () => {
  const tree = buildChangeTree([{ path: 'a\\b.ts', add: 2, del: 0 }])
  assert.equal(tree[0].name, 'a')
  assert.equal(tree[0].children[0].name, 'b.ts')
})

test('收起的目录下面不产出可见行，再展开能恢复', () => {
  const tree = buildChangeTree([
    { path: 'a/b/c.ts', add: 1, del: 1 },
    { path: 'a/d.ts', add: 1, del: 0 },
  ])
  assert.deepEqual(
    visibleChangeRows(tree, new Set()).map((r) => [r.node.name, r.depth]),
    [
      ['a', 0],
      ['b', 1],
      ['c.ts', 2],
      ['d.ts', 1],
    ],
  )
  assert.deepEqual(
    visibleChangeRows(tree, new Set(['a/b'])).map((r) => r.node.name),
    ['a', 'b', 'd.ts'],
  )
  assert.deepEqual(
    visibleChangeRows(tree, new Set(['a'])).map((r) => r.node.name),
    ['a'],
  )
})
