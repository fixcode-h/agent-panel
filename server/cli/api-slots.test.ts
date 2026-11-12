import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiSlot, acquireApi, apiUsage, releaseApi, setApiLimits } from './api-slots.ts'

const tick = () => new Promise((r) => setImmediate(r))

/** 不该发生的「永远等下去」：限时失败，别让一条用例挂死整个测试套 */
const withTimeout = <T>(p: Promise<T>, ms = 1000) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('等超时：排队没有撤销')), ms).unref()),
  ])

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

test('ApiSlot：排队中放弃要撤销排队，放行的名额不能丢在没人持有时', async () => {
  setApiLimits([{ id: 'd', maxConcurrent: 1 }])
  const never = new AbortController().signal
  const holder = new ApiSlot('d', 'D')
  assert.equal(await holder.take(never), true)
  const giving = new ApiSlot('d', 'D')
  const givingBack = giving.take(never)
  await tick()
  assert.deepEqual(apiUsage('d'), { used: 1, queued: 1 })
  // 让出（等子任务 / 等下一句时进程被结束）：队伍要撤掉，不能留着等名额放行
  giving.drop()
  // 不撤销排队时这个 await 永远不返回（名额没人还）：限时把它变成明确的失败
  assert.equal(await withTimeout(givingBack), false)
  assert.equal(giving.holding, false)
  assert.deepEqual(apiUsage('d'), { used: 1, queued: 0 })
  // 名额回到持有者手上：释放后占用归零，不会漏一个永远还不掉的
  holder.drop()
  assert.deepEqual(apiUsage('d'), { used: 0, queued: 0 })

  // 放弃之后还能重新拿：新的排队不受上一次放弃影响
  const again = giving.take(never)
  assert.equal(await again, true)
  assert.equal(giving.holding, true)
  giving.drop()
  assert.deepEqual(apiUsage('d'), { used: 0, queued: 0 })
})

test('ApiSlot：放弃后马上重新排队，旧的排队收尾不能清掉新一代的撤销句柄', async () => {
  setApiLimits([{ id: 'f', maxConcurrent: 1 }])
  const never = new AbortController().signal
  const holder = new ApiSlot('f', 'F')
  assert.equal(await holder.take(never), true)

  const slot = new ApiSlot('f', 'F')
  const first = slot.take(never)
  await tick()
  // 放弃这次排队，紧接着在同一 tick 里重新排队：上一代的 finally 还没跑
  slot.drop()
  const second = slot.take(never)
  await tick()
  // 再放弃：必须能撤销第二次排队，否则名额放行给一个已经不要的 slot、永远不还
  slot.drop()
  assert.equal(await withTimeout(second), false)
  assert.equal(await withTimeout(first), false)
  assert.equal(slot.holding, false)

  holder.drop()
  assert.deepEqual(apiUsage('f'), { used: 0, queued: 0 })
})

/**
 * 「让出后拿回」该按哪种排队显示，判据是让出前手里有没有名额（runner 的 waitNext）：
 * 持有过 = 这一轮已经跑起来，随便让出（yield，界面不显示成排队）；
 * 没持有过 = 预热对话等第一句，这一轮从没出过 token，此刻排队就是真的还没开始（start，要显示）。
 */
test('ApiSlot：holding 能区分「这一轮跑过没有」，预热首句和让出后拿回不会混成一种', async () => {
  setApiLimits([{ id: 'g', maxConcurrent: 1 }])
  const never = new AbortController().signal

  // 预热：gatedRunAgent 跳过 takeApiSlot，所以 slot 手里没有名额
  const warm = new ApiSlot('g', 'G')
  assert.equal(warm.holding, false)
  // 用户发来第一句：这时排队是真排队，按 start
  const holder = new ApiSlot('g', 'G')
  assert.equal(await holder.take(never), true)
  const firstTurn = warm.take(never)
  await tick()
  assert.equal(warm.holding, false)
  holder.drop()
  assert.equal(await withTimeout(firstTurn), true)
  assert.equal(warm.holding, true)

  // 这一轮跑起来了，让出等子任务：让出前 holding 为真，拿回时按 yield
  const yielded = warm.holding
  warm.drop()
  assert.equal(warm.holding, false)
  const back = warm.take(never)
  assert.equal(await withTimeout(back), true)
  assert.equal(yielded, true)
  assert.equal(warm.holding, true)
  warm.drop()
  assert.deepEqual(apiUsage('g'), { used: 0, queued: 0 })
})
