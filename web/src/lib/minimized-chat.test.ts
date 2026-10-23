/**
 * 浮条位置的纯逻辑：夹回视口、拖动阈值、默认槽位、位置记忆。
 * 两个窗口（AI 处理 / AI 优化）共用这一套，改尺寸和间距只改这里。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_INSET, EDGE, clampPos, loadPos, movedEnough, savePos, slotPos } from '@/lib/minimized-chat'

const size = { w: 240, h: 44 }
const view = { w: 1200, h: 800 }

test('clampPos：拖出屏幕后夹回视口，四边都留 EDGE', () => {
  assert.deepEqual(clampPos({ x: -100, y: -100 }, size, view), { x: EDGE, y: EDGE })
  assert.deepEqual(clampPos({ x: 5000, y: 5000 }, size, view), {
    x: view.w - size.w - EDGE,
    y: view.h - size.h - EDGE,
  })
  // 已经在视口里的位置不要动
  assert.deepEqual(clampPos({ x: 300, y: 200 }, size, view), { x: 300, y: 200 })
})

test('clampPos：窗口比浮条还窄时不会算出比下限更小的上限', () => {
  const tiny = { w: 100, h: 30 }
  assert.deepEqual(clampPos({ x: 500, y: 500 }, size, tiny), { x: EDGE, y: EDGE })
})

test('movedEnough：手抖（小于阈值）仍然算点击，超过阈值才算拖动', () => {
  assert.equal(movedEnough(0, 0), false)
  assert.equal(movedEnough(3, -3), false)
  assert.equal(movedEnough(4, 0), true)
  assert.equal(movedEnough(0, -5), true)
})

test('slotPos：默认贴右下角，槽位往上错开，两个浮条不会重叠', () => {
  const a = slotPos(0, size, view)
  const b = slotPos(1, size, view)
  assert.deepEqual(a, { x: view.w - size.w - DEFAULT_INSET, y: view.h - size.h - DEFAULT_INSET })
  assert.ok(b.y < a.y, '第二个浮条要在第一个上面')
  assert.ok(a.y - b.y >= size.h, '两个浮条不能叠在一起')
})

test('位置记忆：按 id 分开存，刷新后能读回来，读不到时返回 null', () => {
  assert.deepEqual(loadPos('ai-fix'), null)
  savePos('ai-fix', { x: 120, y: 340 })
  savePos('assist', { x: 500, y: 600 })
  assert.deepEqual(loadPos('ai-fix'), { x: 120, y: 340 })
  assert.deepEqual(loadPos('assist'), { x: 500, y: 600 })
  // 两个窗口各记各的：拖动一个不会把另一个带走
  savePos('ai-fix', { x: 121, y: 341 })
  assert.deepEqual(loadPos('assist'), { x: 500, y: 600 })
})
