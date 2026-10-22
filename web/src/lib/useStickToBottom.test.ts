/**
 * 贴底判定的纯逻辑：没在浏览器里也能测（node 里没有 ResizeObserver，只用 nearBottom）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nearBottom, STICK_THRESHOLD } from '@/lib/useStickToBottom'

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
