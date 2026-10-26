/**
 * 父对话「提问」和子对话提问的联动规则（见 shared/child-ask.ts）。服务端 PATCH 和界面都按这里的结论走。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childAskChecked, childAskDefaultOf, childAskEffect, childAskInitial, CHILD_ASK_DEFAULT } from './child-ask.ts'

test('默认勾选：新建的父对话「子对话也提问」开着', () => {
  assert.equal(CHILD_ASK_DEFAULT, true)
  assert.equal(childAskInitial({}), true)
  assert.equal(childAskDefaultOf(undefined), true)
})

test('父对话关掉提问：已有子对话一起关，不弹窗也不改「之后新建」的值', () => {
  const e = childAskEffect({ askUser: false })
  assert.equal(e.askUser, false)
  assert.equal(e.existingChildren, false, '已有子对话立即全部关掉')
  assert.equal(e.childAskUser, undefined, '以后重新打开父对话时菜单项还能回到勾选')
})

test('父对话重新打开：只开自己，已有子对话保持各自的选择', () => {
  const e = childAskEffect({ askUser: true })
  assert.equal(e.askUser, true)
  assert.equal(e.existingChildren, undefined, '之前被关掉的子对话不再自动打开')
})

test('右键勾上「子对话也提问」并选应用到已创建：父对话和已有子对话一起开', () => {
  const e = childAskEffect({ childAskUser: true, applyExisting: true })
  assert.equal(e.childAskUser, true)
  assert.equal(e.askUser, true, '父对话开着菜单项才勾得上')
  assert.equal(e.existingChildren, true)
})

test('右键勾上但选只对后续新建：已有子对话不动', () => {
  const e = childAskEffect({ childAskUser: true, applyExisting: false })
  assert.equal(e.childAskUser, true)
  assert.equal(e.existingChildren, undefined)
})

test('右键取消勾选：只影响之后新建的子对话，已有子对话不动', () => {
  const e = childAskEffect({ childAskUser: false })
  assert.equal(e.childAskUser, false)
  assert.equal(e.askUser, undefined, '父对话自己的提问不动')
  assert.equal(e.existingChildren, undefined)
})

test('什么都不传：不改任何东西', () => {
  assert.deepEqual(childAskEffect({}), {})
})

test('菜单项的勾选状态跟着父对话自己的提问走', () => {
  assert.equal(childAskChecked({ askUser: true, childAskUser: true }), true)
  assert.equal(childAskChecked({ askUser: false, childAskUser: true }), false, '父对话关着时这一项显示未勾选')
  assert.equal(childAskChecked({ askUser: true, childAskUser: false }), false)
})
