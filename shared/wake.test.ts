/**
 * 叫醒对话之前的唯一判断（shared/wake.ts 的 wakeHold）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { wakeHold, type WakeInput } from './wake.ts'

const idle: WakeInput = { status: 'done', overBudget: false }

test('叫不叫：用户停下、用量上限、已中断、发件方正在停、整棵树超限不叫；上级交代只看超限；这一轮还在的照常交', () => {
  assert.equal(wakeHold(idle), undefined)
  // 闲置回收、页面切走、父对话收尾停下的不是用户让它停的：照样叫
  for (const why of ['idle', 'presence', 'parent', 'restart'] as const)
    assert.equal(wakeHold({ ...idle, status: 'stopped', stopReason: why }), undefined, why)
  for (const why of ['user', 'budget', 'lost'] as const)
    assert.equal(wakeHold({ ...idle, status: 'stopped', stopReason: why }), why)

  // 执行位上刚按停止：落盘的还是 running，要看执行位；已经被继续了（执行位没停）就不看落盘的旧 stopped
  assert.equal(wakeHold({ ...idle, status: 'running', live: { stop: true, stopReason: 'user' } }), 'user')
  assert.equal(wakeHold({ ...idle, status: 'stopped', stopReason: 'user', live: { stop: false } }), undefined)

  // 发件的子对话正跟着父对话 / 用户 / 用量上限停下：这条是停下前在路上的
  for (const why of ['parent', 'user', 'budget'] as const)
    assert.equal(wakeHold({ ...idle, sender: { stop: true, stopReason: why } }), 'sender', why)
  assert.equal(wakeHold({ ...idle, sender: { stop: true, stopReason: 'presence' } }), undefined)

  // 整棵树超限：空闲的不叫；这一轮还在（用户到上限后自己发消息开的那一轮）照常交进去
  assert.equal(wakeHold({ ...idle, overBudget: true }), 'over')
  assert.equal(wakeHold({ ...idle, status: 'running', overBudget: true, live: { stop: false } }), undefined)
  assert.equal(
    wakeHold({ ...idle, status: 'running', overBudget: true, live: { stop: true, stopReason: 'finish' } }),
    'over',
  )

  // 上级交代（父对话交回被停下 / 已中断的子对话）是重试的做法：目标自己的停下原因不挡，超限照样挡
  assert.equal(wakeHold({ ...idle, status: 'stopped', stopReason: 'lost', fromAbove: true }), undefined)
  assert.equal(wakeHold({ ...idle, status: 'stopped', stopReason: 'user', fromAbove: true }), undefined)
  assert.equal(
    wakeHold({ ...idle, status: 'stopped', stopReason: 'budget', fromAbove: true, overBudget: true }),
    'over',
  )
})
