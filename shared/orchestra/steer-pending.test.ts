/**
 * 父对话执行中的用户插话有没有着落：转给子对话（quote 带了 id）、end_turn 的 own 交代是自己的事、问过一次，都算收口。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ownSteerIds, pendingSteers, STEER_PENDING_MARK, steerPendingBlock } from './steer-pending.ts'
import type { Task, TaskMessage, TaskRoute } from '../schema.ts'

const m = (id: string, role: TaskMessage['role'], text: string, extra: Partial<TaskMessage> = {}): TaskMessage => ({
  id,
  role,
  agentId: '',
  step: '',
  text,
  tools: [],
  at: '2026-11-21T07:52:19.104Z',
  ...extra,
})
const steer = (id: string, text: string, how: 'steer' | 'notes' | 'held' = 'steer') =>
  m(id, 'user', text, { delivery: { how, at: '2026-11-21T07:52:20.000Z' } })
const route = (extra: Partial<TaskRoute> = {}): TaskRoute => ({
  id: 'r',
  target: 'child',
  refs: ['k1'],
  label: '修头衔',
  understanding: '',
  reason: '',
  assumptions: '',
  messageId: '',
  at: '2026-11-21T07:50:00.000Z',
  ...extra,
})

type T = Pick<Task, 'mode' | 'parentTaskId' | 'routes' | 'messages' | 'turnEnds'>
const tk = (messages: TaskMessage[], extra: Partial<T> = {}): T => ({
  mode: 'chat',
  parentTaskId: '',
  routes: [route()],
  messages,
  turnEnds: [],
  ...extra,
})

const base = [m('u0', 'user', '修一下管家头衔'), m('a0', 'agent', '派给子对话了')]

test('父对话执行中插的话没转、没交代：算待处理', () => {
  const r = pendingSteers(tk([...base, steer('u1', '直接改 GetDecorationActorTopLocation'), m('a1', 'agent', '好')]))
  assert.deepEqual(
    r.map((x) => x.id),
    ['u1'],
  )
  assert.match(steerPendingBlock(r), /u1/)
  assert.ok(steerPendingBlock(r).startsWith(STEER_PENDING_MARK))
})

test('没派过子对话、子对话、工作流：不核对', () => {
  const msgs = [...base, steer('u1', '换个做法')]
  assert.equal(pendingSteers(tk(msgs, { routes: [] })).length, 0)
  assert.equal(pendingSteers(tk(msgs, { parentTaskId: 'p' })).length, 0)
  assert.equal(pendingSteers(tk(msgs, { mode: 'workflow' })).length, 0)
})

test('send_to_conversation 带了这条的 quote：算已转', () => {
  const msgs = [...base, steer('u1', '直接改 X')]
  const r = pendingSteers(tk(msgs, { routes: [route(), route({ id: 'r2', target: 'resend', quoted: ['u1'] })] }))
  assert.equal(r.length, 0)
})

test('end_turn 的 own 交代是自己的事：算收口', () => {
  const msgs = [...base, steer('u1', '提交说明写短一点')]
  const r = pendingSteers(tk(msgs, { turnEnds: [{ at: '2026-11-21T07:53:00.000Z', outcome: 'done', own: ['u1'] }] }))
  assert.equal(r.length, 0)
})

test('问过一次就不再问', () => {
  const msgs = [...base, steer('u1', '直接改 X'), m('h', 'system', `${STEER_PENDING_MARK}……`, { panel: 'hook' })]
  assert.equal(pendingSteers(tk(msgs)).length, 0)
})

test('排到下一轮的消息、更早几轮的插话、父对话转来的话不算', () => {
  // held 是这一轮结束后作为新输入处理的：它本身就是新一轮的起点，之前那一轮的插话不再核对
  const msgs = [steer('old', '旧插话'), m('a', 'agent', '…'), steer('u1', '下一轮再说', 'held')]
  assert.equal(pendingSteers(tk(msgs)).length, 0)
  const peer = m('p1', 'user', '转来的', {
    peer: { id: 'x', title: '', name: '', rel: 'child', kind: 'report', subject: '' },
    delivery: { how: 'steer', at: '' },
  })
  assert.equal(pendingSteers(tk([...base, peer])).length, 0)
})

test('own 的 "last" 是用户最近一条，认不出的丢掉', () => {
  const msgs = [...base, steer('u1', 'a'), steer('u2', 'b')]
  assert.deepEqual(ownSteerIds(msgs, ['last', 'nope', 'u1']), ['u2', 'u1'])
})
