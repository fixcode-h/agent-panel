/**
 * 等下一句的登记（server/exec/waiters.ts）：同一个进程先后挂上两个等待时，消息只交给最新那个，
 * 先收尾的那个不能把别人摘掉、自己留在表里。
 * 用户 2026-11-02 复现：消息发出去一闪就没了、输入框还清空了——日志里「停下等下一句 waiters=2」，
 * 消息交给了已经收完尾的旧等待，记成「消息没有记进对话」。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { addWaiter, firstWaiter, removeWaiter, userWaitSlot, waitersOf, type Waiter } from './waiters.ts'

const waiter = (): Waiter => ({ deliver: () => {}, cancel: () => {}, current: () => true })

test('同一个进程又停回等下一句：换下还挂着的旧等待，消息交给新的；旧的停止时收尾不影响新的', () => {
  const slot = userWaitSlot('t1')
  const first = waiter()
  const second = waiter()
  assert.deepEqual(slot.put(first), { replaced: false, size: 1 })
  // CLI 自己又跑了一轮（处理排在输入里的插话）再停回来：旧的那个还挂着
  assert.deepEqual(slot.put(second), { replaced: true, size: 1 }, '表里只留最新这一个')
  assert.equal(firstWaiter('t1'), second, '消息交给最新的等待')
  // 旧的那个在停止时随 signal 收尾：只摘它自己，新的还在
  slot.drop(first)
  assert.equal(firstWaiter('t1'), second, '旧等待收尾不能把新的摘掉')
  slot.drop(second)
  assert.equal(firstWaiter('t1'), undefined)
})

test('收完尾的等待不会留在表里接消息（旧实现共用一个变量时会留下）', () => {
  const slot = userWaitSlot('t2')
  const a = waiter()
  const b = waiter()
  slot.put(a)
  slot.put(b)
  // 新的那个先收到消息收尾，旧的后收尾：表里不能剩下任何一个
  slot.drop(b)
  slot.drop(a)
  assert.deepEqual(waitersOf('t2'), [])
  // 再开一次调用（停止后重启）：只有这次新挂上的
  const next = userWaitSlot('t2')
  const c = waiter()
  assert.deepEqual(next.put(c), { replaced: false, size: 1 })
  assert.equal(firstWaiter('t2'), c)
  next.drop(c)
})

test('等子任务期间的等待和等下一句并存：各摘各的', () => {
  const chat = waiter()
  const helper = waiter()
  addWaiter('t3', helper)
  const slot = userWaitSlot('t3')
  assert.equal(slot.put(chat).size, 2)
  assert.equal(removeWaiter('t3', helper), true)
  assert.equal(removeWaiter('t3', helper), false, '摘过的再摘返回 false')
  assert.equal(firstWaiter('t3'), chat)
  slot.drop(chat)
  assert.deepEqual(waitersOf('t3'), [])
})
