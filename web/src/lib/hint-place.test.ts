import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OFFSET_PX, SIDE_FLIP_LEFT, VIEWPORT_PADDING, place, type Rect } from './hint-place'

const viewport = { width: 1440, height: 900 }
const size = { width: 200, height: 40 }

/** 造一个触发元素的位置：left / top 是左上角，宽高固定 */
const at = (left: number, top: number, width = 100, height = 32): Rect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
})

test('普通元素：浮层放在上方并左对齐', () => {
  const p = place(at(600, 400), size, viewport)
  assert.equal(p.side, 'top')
  assert.equal(p.left, 600)
  assert.equal(p.top, 400 - OFFSET_PX - size.height)
})

test('贴近顶部的元素：上方放不下就翻到下方', () => {
  const p = place(at(600, 4), size, viewport)
  assert.equal(p.side, 'bottom')
  assert.equal(p.top, 4 + 32 + OFFSET_PX)
})

test('侧栏那一列的元素：往右展开，不盖住右边的内容', () => {
  const p = place(at(0, 400, 56, 36), size, viewport)
  assert.equal(p.side, 'right')
  assert.equal(p.left, 56 + OFFSET_PX)
})

test('靠左但右边放不下（窄屏）：退回上下，仍然留在视口里', () => {
  const narrow = { width: 240, height: 800 }
  const p = place(at(0, 400, 56, 36), size, narrow)
  assert.notEqual(p.side, 'right')
  assert.ok(p.left >= VIEWPORT_PADDING)
  assert.ok(p.left + size.width <= narrow.width - VIEWPORT_PADDING)
})

test('靠右边的元素：不被视口右边缘切掉', () => {
  const p = place(at(1400, 400), size, viewport)
  assert.ok(p.left + size.width <= viewport.width - VIEWPORT_PADDING)
})

test('长文字（浮层很宽）放在视口左边：仍然夹在视口里，不出现越过右边缘', () => {
  const wide = { width: 320, height: 120 }
  const p = place(at(10, 400), wide, viewport)
  assert.ok(p.left >= VIEWPORT_PADDING, `left 是 ${p.left}`)
  assert.ok(p.left + wide.width <= viewport.width - VIEWPORT_PADDING, `right 是 ${p.left + wide.width}`)
})

test('浮层比视口还高：不出现负的 top，内容从顶部留白处开始', () => {
  const tall = { width: 200, height: 2000 }
  const p = place(at(600, 400), tall, viewport)
  assert.equal(p.top, VIEWPORT_PADDING)
})

test('上下都放不下时选空间大的那边', () => {
  // 触发元素贴着底边，上方空间多
  const p = place(at(600, 860, 100, 32), size, viewport)
  assert.equal(p.side, 'top')
  // 触发元素贴着顶边，下方空间多
  const q = place(at(600, 0, 100, 32), size, viewport)
  assert.equal(q.side, 'bottom')
})

test('侧栏阈值两侧的行为不一样', () => {
  const size0 = { width: 100, height: 40 }
  const left = place(at(SIDE_FLIP_LEFT - 60, 400, 50, 32), size0, viewport)
  assert.equal(left.side, 'right')
  const right = place(at(SIDE_FLIP_LEFT + 40, 400, 50, 32), size0, viewport)
  assert.equal(right.side, 'top')
})
