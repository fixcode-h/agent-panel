/**
 * 从文件树拖到输入框时插入的引用文字：路径前面没有空隙时补一个空格，文件夹带结尾的斜杠。
 * 这几条错了会让引用和前一个字粘在一起，Agent 读不出来。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insertFileRef } from '@/lib/fileDrag'

function editor(text = '') {
  const state = { text, caret: text.length, focused: false }
  return {
    state,
    text: () => state.text,
    caret: () => state.caret,
    insert: (s: string) => {
      state.text = state.text.slice(0, state.caret) + s + state.text.slice(state.caret)
      state.caret += s.length
    },
    focus: () => {
      state.focused = true
    },
  }
}

test('insertFileRef：文件插入 @相对路径，末尾留空格', () => {
  const ed = editor()
  insertFileRef(ed, { path: 'src/main.ts', kind: 'file' })
  assert.equal(ed.state.text, '@src/main.ts ')
  assert.equal(ed.state.focused, true)
})

test('insertFileRef：文件夹带结尾的斜杠', () => {
  const ed = editor()
  insertFileRef(ed, { path: 'server/exec', kind: 'dir' })
  assert.equal(ed.state.text, '@server/exec/ ')
})

test('insertFileRef：前面紧挨着文字时补一个空格，不跟上一个词粘在一起', () => {
  const ed = editor('看下这个')
  insertFileRef(ed, { path: 'a/b.ts', kind: 'file' })
  assert.equal(ed.state.text, '看下这个 @a/b.ts ')
})

test('insertFileRef：光标前已经有空白时不再补空格', () => {
  const ed = editor('看下这个 ')
  insertFileRef(ed, { path: 'a/b.ts', kind: 'file' })
  assert.equal(ed.state.text, '看下这个 @a/b.ts ')
})

test('insertFileRef：插在光标处，不动后面的内容', () => {
  const ed = editor('开头结尾')
  ed.state.caret = 2
  insertFileRef(ed, { path: 'a.ts', kind: 'file' })
  assert.equal(ed.state.text, '开头 @a.ts 结尾')
})
