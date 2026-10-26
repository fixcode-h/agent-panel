import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiSlot, apiUsage, setApiLimits } from '../api-slots.ts'
import { clearApiWait, markApiWait } from './api-wait.ts'

import type { ApiWait } from '../../shared/schema.ts'

const tick = () => new Promise((r) => setImmediate(r))

/** 不撤销排队时那个 await 永远不返回（名额没人还）：限时把它变成明确的失败，别挂死整个套 */
const withTimeout = <T>(p: Promise<T>, ms = 1000) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('等超时：排队没有撤销')), ms).unref()),
  ])

/** 最小上下文：只记推送了几次，让断言看得出标记变化有没有通知界面 */
const fakeCtx = () => {
  const log: boolean[] = []
  const task: { apiWait?: ApiWait } = {}
  return { task, changed: () => log.push(true), log }
}

test('排队标记：记下来就清干净，清完再清不会重复推送', () => {
  const ctx = fakeCtx()

  markApiWait(ctx, undefined, 'OpenDesign', 0, 'start')
  assert.deepEqual(ctx.task.apiWait, { api: 'OpenDesign', ahead: 0, reason: 'start' })
  assert.equal(ctx.log.length, 1)

  // 队伍动了：前面少了一个，标记跟着更新
  markApiWait(ctx, undefined, 'OpenDesign', 0, 'start')
  assert.equal(ctx.task.apiWait?.ahead, 0)

  clearApiWait(ctx, undefined)
  assert.equal(ctx.task.apiWait, undefined)
  assert.equal(ctx.log.length, 3)
  // 已经没有标记时不再推送：拿到名额后不该多推一次空变化
  clearApiWait(ctx, undefined)
  assert.equal(ctx.log.length, 3)
})

test('排队标记：让出后拿回不改步骤状态，开跑前排队才改成排队中', () => {
  const ctx = fakeCtx()
  const step = { status: 'running' as const, apiWait: undefined as ApiWait | undefined }

  // 这一轮已经跑起来、让出名额后去拿回：仍是「执行中」，只标出在等谁
  const before = markApiWait(ctx, step, 'A', 2, 'yield')
  assert.deepEqual(step.apiWait, { api: 'A', ahead: 2, reason: 'yield' })
  assert.equal(step.status, 'running')
  clearApiWait(ctx, step, before)
  assert.equal(step.apiWait, undefined)
  assert.equal(step.status, 'running')

  // 还没开跑就排着：显示成排队中，拿到后回执行中
  const before2 = markApiWait(ctx, step, 'A', 0, 'start')
  assert.equal(step.status, 'pending')
  clearApiWait(ctx, step, before2)
  assert.equal(step.status, 'running')
})

/**
 * 截图那个 bug 的数据层：对话这一轮正在出 token，同时在「让出名额等子任务」之后排队拿回，
 * 标记必须带 reason='yield'（界面才不会显示成在排队），并且不管怎么离开都要清掉。
 */
test('排队标记：让出后拿回带着 yield 来源，拿到名额或被停止都清掉', async () => {
  setApiLimits([{ id: 'e', maxConcurrent: 1 }])
  const never = new AbortController().signal
  const ctx = fakeCtx()

  // 另一个调用占着唯一的名额：这次拿回必然排队
  const other = new ApiSlot('e', 'E')
  assert.equal(await other.take(never), true)

  const slot = new ApiSlot('e', 'E')
  const seen: string[] = []
  const taken = slot.take(never, (ahead) => {
    markApiWait(ctx, undefined, slot.name, ahead, 'yield')
    seen.push(`${ctx.task.apiWait?.reason}/${ctx.task.apiWait?.ahead}`)
  })
  await tick()
  assert.deepEqual(seen, ['yield/0'])
  assert.equal(ctx.task.apiWait?.reason, 'yield')

  // 排队中被停止：标记也要清，不能留一条陈旧的「在排队」
  const stop = new AbortController()
  const stoppedSlot = new ApiSlot('e', 'E')
  const stopped = stoppedSlot.take(stop.signal, (ahead) => markApiWait(ctx, undefined, 'E', ahead, 'yield'))
  await tick()
  assert.ok(ctx.task.apiWait)
  stop.abort()
  assert.equal(await stopped, false)
  clearApiWait(ctx, undefined)
  assert.equal(ctx.task.apiWait, undefined)

  // 名额放行给前面那次排队：拿到后调用方在 finally 里清标记
  other.drop()
  assert.equal(await withTimeout(taken), true)
  clearApiWait(ctx, undefined)
  assert.equal(ctx.task.apiWait, undefined)
  slot.drop()
  assert.deepEqual(apiUsage('e'), { used: 0, queued: 0 })
})
