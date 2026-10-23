/**
 * 贴底判定的纯逻辑：没在浏览器里也能测（node 里没有 ResizeObserver，只用 nearBottom）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nearBottom, STICK_THRESHOLD, stillPinned } from '@/lib/useStickToBottom'

test('nearBottom：停在底部时贴底', () => {
  assert.equal(nearBottom({ scrollTop: 1200, scrollHeight: 1600, clientHeight: 400 }), true)
})

test('nearBottom：往上翻超过阈值就不算贴底，用户看老内容时不能被拽回去', () => {
  assert.equal(nearBottom({ scrollTop: 0, scrollHeight: 5000, clientHeight: 400 }), false)
})

test('nearBottom：刚好在阈值内仍算贴底，滚回底部附近恢复跟随', () => {
  const far = { scrollTop: 1600 - 400 - STICK_THRESHOLD, scrollHeight: 1600, clientHeight: 400 }
  assert.equal(nearBottom(far), true)
  assert.equal(nearBottom({ ...far, scrollTop: far.scrollTop - 1 }), false)
})

test('nearBottom：内容不足一屏（没有滚动条）时贴底，不出现「用户翻上去了」', () => {
  assert.equal(nearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 }), true)
})

test('stillPinned：自己贴底后内容又变高，滚动事件读到离底部很远，也不能当成用户翻上去', () => {
  // 贴底时 scrollTop=1200（scrollHeight 1600），事件派发前插进来 300px 的工具卡片
  assert.equal(stillPinned({ scrollTop: 1200, scrollHeight: 1900, clientHeight: 400 }, 1200, true), true)
})

test('stillPinned：真的往上滚了才不再跟随', () => {
  assert.equal(stillPinned({ scrollTop: 800, scrollHeight: 1600, clientHeight: 400 }, 1200, true), false)
})

test('stillPinned：翻上去之后往下滚但没到底，仍不跟随；滚回底部附近恢复', () => {
  assert.equal(stillPinned({ scrollTop: 900, scrollHeight: 1600, clientHeight: 400 }, 800, false), false)
  assert.equal(stillPinned({ scrollTop: 1190, scrollHeight: 1600, clientHeight: 400 }, 900, false), true)
})
