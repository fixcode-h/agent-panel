import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssistJob } from '@shared/assist'
import type { TaskMessage } from '@shared/schema'
import { historyOf, splitAtCuts, turnsFromCuts } from './assist-steer'

const m = (id: string): TaskMessage => ({ id, role: 'agent', agentId: '', step: '', text: id, tools: [], at: '' })
const job = (msgs: TaskMessage[], unread?: string[]): AssistJob => ({
  id: 'j',
  kind: 'project',
  targetId: '',
  status: 'done',
  text: '说明',
  attempt: 1,
  messages: msgs,
  unread,
})

test('插话把这一轮的回复切开：插话后的输出排在用户这句后面', () => {
  const msgs = [m('a'), m('b'), m('c')]
  assert.deepEqual(
    splitAtCuts(msgs, [{ at: 2, text: '快点' }]).map((s) => s.map((x) => x.id)),
    [['a', 'b'], ['c']],
  )
  assert.deepEqual(splitAtCuts(msgs, []).length, 1)
})

test('一轮结束：插话成为用户消息，没被取走的放回队列，空回复不进对话记录', () => {
  const r = turnsFromCuts(job([m('a'), m('b')], ['没取走']), [
    { at: 1, text: '还没好？' },
    { at: 2, text: '没取走' },
  ])
  assert.deepEqual(
    r.before.map((x) => [x.role, x.text]),
    [
      ['assistant', ''],
      ['user', '还没好？'],
    ],
  )
  assert.deepEqual(
    r.last.map((x) => x.id),
    ['b'],
  )
  assert.deepEqual(r.requeue, ['没取走'])
  assert.deepEqual(historyOf([{ role: 'user', text: '初始化' }, ...r.before, { role: 'assistant', text: '好了' }]), [
    { role: 'user', text: '初始化' },
    { role: 'user', text: '还没好？' },
    { role: 'assistant', text: '好了' },
  ])
})
