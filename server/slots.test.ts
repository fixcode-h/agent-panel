import assert from 'node:assert/strict'
import test from 'node:test'
import { createSlotPool, releaseIfSame, reserveOnce } from './slots.ts'

/** 让 async 函数里的 await 都跑完一轮 */
const tick = () => new Promise<void>((r) => setImmediate(r))

test('并发发消息：同一个任务只占到一个执行位，后来的复用已有的一份', () => {
  const live = new Map<string, { run: number }>()
  const first = reserveOnce(live, 't', () => ({ run: 1 }))
  const second = reserveOnce(live, 't', () => ({ run: 2 }))
  assert.equal(first.fresh, true)
  assert.equal(second.fresh, false)
  // 不能覆盖正在执行的那一份
  assert.equal(second.value, first.value)

  // 旧的一轮收尾时，新的一轮已经占住了执行位：不能把它删掉
  const newer = { run: 3 }
  live.set('t', newer)
  releaseIfSame(live, 't', first.value)
  assert.equal(live.get('t'), newer)
  releaseIfSame(live, 't', newer)
  assert.equal(live.has('t'), false)
})

test('超过上限的排队，释放时把名额直接交给等待者，不会超卖', async () => {
  const pool = createSlotPool(() => 1)
  const first = await pool.take('p')
  assert.equal(pool.running('p'), 1)

  let second: (() => void) | undefined
  const waiting = pool.take('p').then((free) => (second = free))
  await tick()
  assert.equal(pool.queued('p'), 1)
  assert.equal(pool.running('p'), 1, '等待者醒来之前不能先占名额')

  first()
  await waiting
  assert.equal(pool.running('p'), 1, '名额直接交接，计数不变')
  assert.equal(pool.queued('p'), 0)

  // 交接期间新来的请求要排在后面，不能插队多占一个
  const third = pool.take('p')
  await tick()
  assert.equal(pool.queued('p'), 1)
  assert.equal(pool.running('p'), 1)

  second!()
  const thirdFree = await third
  assert.equal(pool.running('p'), 1)
  thirdFree()
  assert.equal(pool.running('p'), 0)
})

test('停止时排空队列：等着的调用拿到明确失败，不会永远挂着', async () => {
  const pool = createSlotPool(() => 1)
  const free = await pool.take('p')
  const waiting = pool.take('p')
  await tick()
  assert.equal(pool.queued('p'), 1)

  pool.drain('p', new Error('任务已停止'))
  await assert.rejects(waiting, /任务已停止/)
  assert.equal(pool.queued('p'), 0)
  // 已经在执行的那个不受影响，它释放后才真正空出来
  assert.equal(pool.running('p'), 1)
  free()
  assert.equal(pool.running('p'), 0)
})

test('并发闸：同时最多 n 个，多的排队，前面的结束一个就放一个', async () => {
  const { createGate } = await import('./slots.ts')
  const gate = createGate(2)
  let running = 0
  let peak = 0
  const opens: (() => void)[] = []
  const job = () =>
    gate(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise<void>((r) => opens.push(r))
      running--
    })
  const all = [job(), job(), job(), job()]
  await tick()
  await tick()
  assert.equal(running, 2)
  while (opens.length || running) {
    opens.shift()?.()
    await tick()
    await tick()
  }
  await Promise.all(all)
  assert.equal(peak, 2)
})
