import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryActive, deliveryStatus } from './task.ts'

test('deliveryStatus：发送中、没送出去一直显示；插进去、排队的只在那一轮还在跑时显示', () => {
  assert.equal(deliveryStatus('pending', false)?.tone, 'pending')
  assert.equal(deliveryStatus('lost', false)?.tone, 'warn')
  for (const how of ['wait', 'steer', 'notes'] as const) {
    // 三种对用户是同一件事：统一成一句
    assert.equal(deliveryStatus(how, true)?.text, deliveryStatus('steer', true)?.text)
    assert.equal(deliveryStatus(how, false), null)
  }
  assert.equal(deliveryStatus('held', true)?.tone, 'wait')
  assert.equal(deliveryStatus('held', false), null)
  // 新开一轮、卡住重启不用在气泡上说明（重启另有系统提示）
  assert.equal(deliveryStatus('next', true), null)
  assert.equal(deliveryStatus('restart', true), null)
  assert.equal(deliveryStatus(undefined, true), null)
})

test('deliveryActive：对话在跑、而且是最近一轮完成之后交的才算这一轮', () => {
  const at = '2026-10-31T10:00:00.000Z'
  assert.equal(deliveryActive(at, { working: true, turnDoneAt: '' }), true)
  assert.equal(deliveryActive(at, { working: true, turnDoneAt: '2026-10-31T09:59:00.000Z' }), true)
  // 交的那一轮已经结束（排队的消息在下一轮开始前交的）：不再挂着
  assert.equal(deliveryActive(at, { working: true, turnDoneAt: '2026-10-31T10:01:00.000Z' }), false)
  assert.equal(deliveryActive(at, { working: false, turnDoneAt: '' }), false)
})
