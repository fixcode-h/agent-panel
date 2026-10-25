import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiSlot, acquireApi, apiUsage, releaseApi, setApiLimits } from './api-slots.ts'

const tick = () => new Promise((r) => setImmediate(r))

test('API 并发上限：0 不限制，满了按到达顺序排队，释放时交给最前面的', async () => {
  setApiLimits([{ id: 'a', maxConcurrent: 0 }])
  const never = new AbortController().signal
  for (let i = 0; i < 5; i++) assert.equal(await acquireApi('a', never), true)
  assert.equal(apiUsage('a').used, 5)
  for (let i = 0; i < 5; i++) releaseApi('a')

  setApiLimits([{ id: 'a', maxConcurrent: 2 }])
  assert.equal(await acquireApi('a', never), true)
  assert.equal(await acquireApi('a', never), true)
  const order: string[] = []
  const ahead: number[] = []
  const third = acquireApi('a', never, (n) => ahead.push(n)).then(() => order.push('third'))
  const fourth = acquireApi('a', never).then(() => order.push('fourth'))
  await tick()
  assert.deepEqual(order, [])
  assert.deepEqual(apiUsage('a'), { used: 2, queued: 2 })
  releaseApi('a')
  await third
  await tick()
  assert.deepEqual(order, ['third'])
  // 名额直接交接：占用数不变，第四个还在排
  assert.deepEqual(apiUsage('a'), { used: 2, queued: 1 })
  assert.deepEqual(ahead, [0])
  releaseApi('a')
  await fourth
  assert.deepEqual(order, ['third', 'fourth'])
  releaseApi('a')
  releaseApi('a')
  assert.deepEqual(apiUsage('a'), { used: 0, queued: 0 })
})

test('API 并发上限：排队时停止就离开队伍，调大上限马上放行', async () => {
  setApiLimits([{ id: 'b', maxConcurrent: 1 }])
  const never = new AbortController().signal
  assert.equal(await acquireApi('b', never), true)
  const stop = new AbortController()
  const stopped = acquireApi('b', stop.signal)
  const moves: number[] = []
  const later = acquireApi('b', never, (n) => moves.push(n))
  stop.abort()
  assert.equal(await stopped, false)
  // 前面那个走了，后面的往前挪
  assert.deepEqual(moves, [1, 0])
  setApiLimits([{ id: 'b', maxConcurrent: 2 }])
  assert.equal(await later, true)
  assert.deepEqual(apiUsage('b'), { used: 2, queued: 0 })
  releaseApi('b')
  releaseApi('b')
})

test('ApiSlot：让出和拿回不会多占或多还', async () => {
  setApiLimits([{ id: 'c', maxConcurrent: 1 }])
  const never = new AbortController().signal
  const slot = new ApiSlot('c', 'C')
  assert.equal(await slot.take(never), true)
  assert.equal(await slot.take(never), true)
  assert.equal(apiUsage('c').used, 1)
  // 让出后别人能用（例如父对话等子任务时子任务拿到名额）
  slot.drop()
  slot.drop()
  const other = new ApiSlot('c', 'C')
  assert.equal(await other.take(never), true)
  const back = slot.take(never)
  await tick()
  assert.equal(slot.holding, false)
  other.drop()
  assert.equal(await back, true)
  assert.equal(slot.holding, true)
  slot.drop()
  assert.deepEqual(apiUsage('c'), { used: 0, queued: 0 })
})
