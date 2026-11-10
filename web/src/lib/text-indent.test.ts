import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indentEdit, indentUnit } from './text-indent.ts'

/** 把一次缩进落到文本上，返回新文本和选区，断言起来直观 */
const apply = (text: string, s: number, e: number, out: boolean, unit = '  ') => {
  const r = indentEdit(text, s, e, out, unit)
  if (!r) return null
  const next = text.slice(0, r.from) + r.insert + text.slice(r.to)
  return { next, sel: next.slice(r.selStart, r.selEnd), caret: r.selStart }
}

test('缩进单位：Tab 多用 Tab，空格看最窄的一级，没有缩进时两个空格', () => {
  assert.equal(indentUnit('a\n\tb\n\t\tc'), '\t')
  assert.equal(indentUnit('a\n  b\n    c'), '  ')
  assert.equal(indentUnit('a\n    b\n        c'), '    ')
  assert.equal(indentUnit('# 标题\n正文'), '  ')
})

test('没选中时 Tab 在光标处插入一级缩进，光标跟到后面', () => {
  const r = apply('ab', 1, 1, false)!
  assert.equal(r.next, 'a  b')
  assert.equal(r.caret, 3)
})

test('选中跨行时整行缩进，空行不加；选区停在下一行行首时那一行不算', () => {
  const text = 'a\n\nb\nc'
  const r = apply(text, 0, 5, false)!
  assert.equal(r.next, '  a\n\n  b\nc')
  assert.equal(r.sel, '  a\n\n  b\n')
})

test('Shift+Tab 减一级：Tab 或最多一级宽的空格；没缩进的行不动，全都没缩进时返回 null', () => {
  assert.equal(apply('    a\n\tb\n c', 0, 11, true)!.next, '  a\nb\nc')
  assert.equal(apply('  a', 3, 3, true)!.next, 'a')
  assert.equal(apply('  a', 3, 3, true)!.caret, 1)
  assert.equal(indentEdit('a\nb', 0, 3, true, '  '), null)
})
