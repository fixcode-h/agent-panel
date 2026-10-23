import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineClass, numbered, sideBySide } from './diff-rows'

const NEW_FILE = [
  'diff --git a/docs/demo.md b/docs/demo.md',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/docs/demo.md',
  '@@ -0,0 +1,3 @@',
  '+第一行',
  '+第二行',
  '+第三行',
]

const DELETE_FILE = [
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  'index 1111111..0000000',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone one',
  '-gone two',
]

test('文件头不显示，块头保留，增删行各有自己的样式', () => {
  assert.equal(lineClass('diff --git a/a b/a'), null)
  assert.equal(lineClass('index 111..222'), null)
  assert.equal(lineClass('--- a/a'), null)
  assert.equal(lineClass('+++ b/a'), null)
  assert.equal(lineClass('new file mode 100644'), null)
  assert.equal(lineClass('@@ -1,2 +1,3 @@'), 'bg-field text-subtle')
  assert.equal(lineClass('+x'), 'bg-success/10 text-success')
  assert.equal(lineClass('-x'), 'bg-danger/10 text-danger')
  assert.equal(lineClass(' x'), 'text-muted')
})

test('纯新增：行号只在改后一侧，第一行从 1 开始', () => {
  const rows = numbered(NEW_FILE)
  assert.deepEqual(
    rows.map((r) => [r.l, r.a, r.b]),
    [
      ['@@ -0,0 +1,3 @@', undefined, undefined],
      ['+第一行', undefined, 1],
      ['+第二行', undefined, 2],
      ['+第三行', undefined, 3],
    ],
  )
})

test('纯删除：行号只在改前一侧', () => {
  assert.deepEqual(
    numbered(DELETE_FILE)
      .slice(1)
      .map((r) => [r.a, r.b]),
    [
      [1, undefined],
      [2, undefined],
    ],
  )
})

test('上下文行两侧同号，多个块的起始行号按 @@ 重算', () => {
  const rows = numbered(['@@ -10,4 +10,4 @@', ' same', '-old', '+new', '@@ -40,1 +41,1 @@', ' tail'])
  assert.deepEqual(
    rows.map((r) => [r.a, r.b]),
    [
      [undefined, undefined],
      [10, 10],
      [11, undefined],
      [undefined, 11],
      [undefined, undefined],
      [40, 41],
    ],
  )
})

test('左右对照：删行增行按位置配对，多出来的一侧留空', () => {
  const rows = sideBySide(['@@ -1,2 +1,3 @@', '-a', '-b', '+a2', '+b2', '+c2'])
  assert.deepEqual(
    rows.map((r) => (r.kind === 'pair' ? [r.left?.l, r.right?.l] : r.kind)),
    ['hunk', ['a', 'a2'], ['b', 'b2'], [undefined, 'c2']],
  )
})

test('左右对照：新增文件整条左栏为空，删除文件右栏为空', () => {
  const added = sideBySide(NEW_FILE)
  assert.equal(added[0].kind, 'hunk')
  assert.deepEqual(
    added.slice(1).map((r) => (r.kind === 'pair' ? [r.left, r.right?.n] : null)),
    [
      [undefined, 1],
      [undefined, 2],
      [undefined, 3],
    ],
  )
  const removed = sideBySide(DELETE_FILE)
  assert.deepEqual(
    removed.slice(1).map((r) => (r.kind === 'pair' ? [r.left?.n, r.right] : null)),
    [
      [1, undefined],
      [2, undefined],
    ],
  )
})

test('左右对照：上下文行两侧内容相同，块头和「没有换行」说明各占一整行', () => {
  const rows = sideBySide(['@@ -1,2 +1,2 @@', ' keep', '-before', '+after', '\\ No newline at end of file'])
  assert.deepEqual(
    rows.map((r) => (r.kind === 'pair' ? ['pair', r.left?.l, r.right?.l] : [r.kind, r.l])),
    [
      ['hunk', '@@ -1,2 +1,2 @@'],
      ['pair', 'keep', 'keep'],
      ['pair', 'before', 'after'],
      ['note', '\\ No newline at end of file'],
    ],
  )
})

test('空 diff 和只有文件头的 diff 都排不出行', () => {
  assert.deepEqual(sideBySide([]), [])
  assert.deepEqual(numbered([]), [])
  const headerOnly = ['diff --git a/a b/a', 'index 111..222', '--- a/a', '+++ b/a']
  assert.deepEqual(sideBySide(headerOnly), [])
  assert.deepEqual(numbered(headerOnly), [])
})
