/**
 * 技能文件夹的文件树：后端给扁平条目 + 完整 path，前端只还原层级。
 * 覆盖空目录、深层嵌套、父目录没单列、折叠和文件计数。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFileEntry } from '@shared/library'
import { countFiles, entryName, toTree, visibleRows } from '@/lib/library-tree'

const file = (path: string, size = 10): LibraryFileEntry => ({ path, type: 'file', size })
const dir = (path: string): LibraryFileEntry => ({ path, type: 'dir' })

test('toTree：顶层文件原样成一排，深度都是 0', () => {
  const rows = toTree([file('README.md'), file('notes.txt')])
  assert.deepEqual(
    rows.map((r) => [r.path, r.depth, r.children]),
    [
      ['README.md', 0, undefined],
      ['notes.txt', 0, undefined],
    ],
  )
})

test('toTree：目录带子项，子项深度加一，保持后端给的顺序', () => {
  const rows = toTree([dir('references'), file('references/a.md'), file('references/b.md')])
  assert.equal(rows.length, 1)
  const [refs] = rows
  assert.equal(refs.type, 'dir')
  assert.equal(refs.depth, 0)
  assert.deepEqual(
    refs.children?.map((c) => [c.path, c.depth]),
    [
      ['references/a.md', 1],
      ['references/b.md', 1],
    ],
  )
})

test('toTree：深层嵌套逐级还原，空目录也留在树里', () => {
  const rows = toTree([
    dir('references'),
    dir('references/pitfalls'),
    file('references/pitfalls/x.md'),
    dir('templates'),
  ])
  const [refs, templates] = rows
  assert.equal(refs.depth, 0)
  const pitfalls = refs.children![0]
  assert.equal(pitfalls.path, 'references/pitfalls')
  assert.equal(pitfalls.depth, 1)
  assert.equal(pitfalls.children![0].path, 'references/pitfalls/x.md')
  assert.equal(pitfalls.children![0].depth, 2)
  // 空目录：没有 children 内容，但条目还在
  assert.equal(templates.type, 'dir')
  assert.deepEqual(templates.children, [])
})

test('toTree：父目录没单列时补出目录，路径不丢', () => {
  const rows = toTree([file('a/b/c.md')])
  const a = rows[0]
  assert.equal(a.path, 'a')
  assert.equal(a.type, 'dir')
  assert.equal(a.depth, 0)
  assert.equal(a.children![0].path, 'a/b')
  assert.equal(a.children![0].children![0].path, 'a/b/c.md')
  assert.equal(a.children![0].children![0].depth, 2)
  // 补出来的目录没有大小，不能被当成文件
  assert.equal(a.children![0].children![0].type, 'file')
})

test('toTree：空列表给空树', () => {
  assert.deepEqual(toTree([]), [])
})

test('visibleRows：全展开时按树的顺序铺平，收起目录时跳过它的子项', () => {
  const rows = toTree([dir('references'), file('references/a.md'), file('top.md')])
  assert.deepEqual(
    visibleRows(rows, new Set()).map((r) => r.path),
    ['references', 'references/a.md', 'top.md'],
  )
  // 收起的目录自己还在，子项不显示
  assert.deepEqual(
    visibleRows(rows, new Set(['references'])).map((r) => r.path),
    ['references', 'top.md'],
  )
})

test('visibleRows：收起内层目录时外层不受影响', () => {
  const rows = toTree([dir('a'), dir('a/b'), file('a/b/c.md'), file('a/d.md')])
  assert.deepEqual(
    visibleRows(rows, new Set(['a/b'])).map((r) => r.path),
    ['a', 'a/b', 'a/d.md'],
  )
})

test('countFiles：只数文件，不数目录（空目录不计）', () => {
  const rows = toTree([dir('references'), file('references/a.md'), file('references/b.md'), dir('empty'), file('x.md')])
  assert.equal(countFiles(rows), 3)
  assert.equal(countFiles([]), 0)
})

test('toTree：只有扁平的 files 列表（旧后端）时也能还原层级', () => {
  // entriesOf 在后端没返回 tree 时按 files 造条目，这里锁住那种输入也能成型
  const rows = toTree(['examples.md', 'references/pitfalls.md'].map((path) => ({ path, type: 'file' as const })))
  assert.deepEqual(
    visibleRows(rows, new Set()).map((r) => `${r.type}:${r.path}@${r.depth}`),
    ['file:examples.md@0', 'dir:references@0', 'file:references/pitfalls.md@1'],
  )
})

test('entryName：取路径最后一段', () => {
  assert.equal(entryName('references/pitfalls/x.md'), 'x.md')
  assert.equal(entryName('x.md'), 'x.md')
})
