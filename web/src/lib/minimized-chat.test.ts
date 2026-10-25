/**
 * 浮条位置的纯逻辑：夹回视口、拖动阈值、默认位置、位置记忆。
 * 三类浮条（AI 处理 / AI 优化 / 收起的对话）共用这一套，改尺寸和间距只改这里。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_INSET, EDGE, clampPos, loadPos, movedEnough, savePos } from '@/lib/minimized-chat'

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

test('默认位置：贴右下角，和 tailwind 的 right-5 / bottom-5 对上', () => {
  // 没拖过的浮条用 DEFAULT_INSET 定位（MinimizedChat 里的内联样式）；
  // 屏幕任意时刻只有一个浮条（见 chat-dock.ts），不再按槽位错开
  assert.equal(DEFAULT_INSET, 20)
  assert.ok(DEFAULT_INSET >= EDGE, '默认位置不能贴得比拖动留的边还紧')
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
