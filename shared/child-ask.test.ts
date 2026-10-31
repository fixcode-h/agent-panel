/**
 * 父对话「提问」和子对话提问的联动规则（见 shared/child-ask.ts）。服务端 PATCH 和界面都按这里的结论走。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childAskChecked, childAskEffect, childAskInitial, CHILD_ASK_DEFAULT } from './child-ask.ts'

test('默认勾选：新建的父对话「子对话也提问」开着', () => {
  assert.equal(CHILD_ASK_DEFAULT, true)
  assert.equal(childAskInitial({}), true)
})

test('父对话关掉提问：只关自己，已有子对话和「之后新建」的值都不动', () => {
  const e = childAskEffect({ askUser: false })
  assert.equal(e.askUser, false)
  assert.equal(e.existingChildren, undefined, '提问按钮只影响自己的提问设置')
  assert.equal(e.childAskUser, undefined)
})

test('父对话重新打开：只开自己，已有子对话保持各自的选择', () => {
  const e = childAskEffect({ askUser: true })
  assert.equal(e.askUser, true)
  assert.equal(e.existingChildren, undefined, '之前被关掉的子对话不再自动打开')
})

test('右键勾上「子对话也提问」并选应用到已创建：已有子对话一起开，父对话自己不动', () => {
  const e = childAskEffect({ childAskUser: true, applyExisting: true })
  assert.equal(e.childAskUser, true)
  assert.equal(e.askUser, undefined, '父对话自己的提问不跟着变')
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

test('菜单项的勾选状态只看「子对话也提问」，不跟父对话自己的提问走', () => {
  assert.equal(childAskChecked({ askUser: true, childAskUser: true }), true)
  assert.equal(childAskChecked({ askUser: false, childAskUser: true }), true, '父对话关着时这一项照旧显示')
  assert.equal(childAskChecked({ askUser: true, childAskUser: false }), false)
})
