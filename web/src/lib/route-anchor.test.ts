/** 分诊卡插在 AI 回复里哪个位置：对回发起它的那条消息，对不上的留在用户消息下面 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskMessage, TaskRoute } from '@shared/schema'
import { routeAnchors, sameAnchors } from './route-anchor.ts'

const msg = (id: string, sec: number, extra: Partial<TaskMessage> = {}): TaskMessage => ({
  id,
  role: 'agent',
  agentId: 'a',
  step: '',
  text: '',
  tools: [],
  at: new Date(Date.UTC(2026, 10, 5, 0, 0, sec)).toISOString(),
  ...extra,
})
const route = (id: string, sec: number, extra: Partial<TaskRoute> = {}): TaskRoute => ({
  id,
  target: 'child',
  refs: [],
  label: '',
  understanding: '',
  reason: '',
  assumptions: '',
  messageId: 'u1',
  at: new Date(Date.UTC(2026, 10, 5, 0, 0, sec)).toISOString(),
  ...extra,
})
const ids = (m: Map<string, TaskRoute[]>) => Object.fromEntries([...m].map(([k, v]) => [k, v.map((r) => r.id)]))

test('新开子对话挂在派单调用那条回复后面，不挂到之后的说明上', () => {
  const msgs = [msg('u1', 0, { role: 'user' }), msg('a1', 1), msg('a2', 3), msg('a3', 6)]
  // a2 在 3 秒出现（派单调用在它里面），4 秒记下分诊，6 秒才有下一条
  assert.deepEqual(ids(routeAnchors(msgs, [route('r1', 4)])), { a2: ['r1'] })
})

test('派子任务按 spawned 对上那条派出消息，同一处的几条归在一起', () => {
  const msgs = [
    msg('u1', 0, { role: 'user' }),
    msg('a1', 1),
    msg('s1', 2, { role: 'system', spawned: ['h1', 'h2'] }),
    msg('a2', 3),
  ]
  const routes = [
    route('r1', 9, { target: 'subtask', refs: ['h1'] }),
    route('r2', 9, { target: 'subtask', refs: ['h2'] }),
  ]
  assert.deepEqual(ids(routeAnchors(msgs, routes)), { s1: ['r1', 'r2'] })
})

test('不跨到下一条用户消息，子任务的输出也不算；对不上时留在出自的用户消息上', () => {
  const msgs = [
    msg('u1', 0, { role: 'user' }),
    msg('h', 1, { step: 'h1' }),
    msg('u2', 2, { role: 'user' }),
    msg('a1', 3),
  ]
  assert.deepEqual(ids(routeAnchors(msgs, [route('r1', 5)])), { u1: ['r1'] })
})

test('挂载位置没变时认作一样（沿用旧引用，消息列表不重画）', () => {
  const msgs = [msg('u1', 0, { role: 'user' }), msg('a1', 1)]
  const a = routeAnchors(msgs, [route('r1', 2)])
  assert.ok(sameAnchors(a, routeAnchors([...msgs, msg('a2', 3)], [route('r1', 2)])))
  assert.ok(!sameAnchors(a, routeAnchors(msgs, [route('r1', 2), route('r2', 2)])))
})
