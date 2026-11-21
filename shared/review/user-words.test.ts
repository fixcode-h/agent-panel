/**
 * 派评审时附上用户说过的话：用户亲口说的加父对话转来的原话，按时间排，超长留最近的。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { userWordsOf, userWordsPart } from './user-words.ts'
import type { TaskMessage } from '../schema.ts'

const m = (id: string, at: string, text: string, extra: Partial<TaskMessage> = {}): TaskMessage => ({
  id,
  role: 'user',
  agentId: '',
  step: '',
  text,
  tools: [],
  at,
  ...extra,
})
const parent = (id: string, at: string, said: { id: string; at: string; text: string }[]) =>
  m(id, at, '父对话的派单', {
    peer: { id: 'p', title: '', name: '', rel: 'parent', kind: 'task', subject: '', said },
  })

test('用户亲口说的和父对话转来的原话按时间排；父对话的派单本身、面板消息不算', () => {
  const msgs = [
    parent('p1', '2026-11-21T08:00:00Z', [
      { id: 'q1', at: '2026-11-21T07:59:00Z', text: '直接改 GetDecorationActorTopLocation' },
    ]),
    m('u1', '2026-11-21T08:05:00Z', '用 PlatActor 吧'),
    m('n1', '2026-11-21T08:06:00Z', '面板提醒', { panel: 'nudge' }),
  ]
  const w = userWordsOf({ messages: msgs })
  assert.deepEqual(
    w.map((x) => [x.id, !!x.quoted]),
    [
      ['q1', true],
      ['u1', false],
    ],
  )
  const part = userWordsPart({ messages: msgs })
  assert.match(part, /GetDecorationActorTopLocation/)
  assert.match(part, /🟠 中级/)
})

test('超过上限留最近的，并说明更早的没附上；用户什么都没说过时不附', () => {
  const msgs = [m('u1', '2026-11-21T08:00:00Z', '早'.repeat(300)), m('u2', '2026-11-21T08:01:00Z', '最近这句')]
  const part = userWordsPart({ messages: msgs }, 50)
  assert.match(part, /最近这句/)
  assert.doesNotMatch(part, /早早早/)
  assert.match(part, /更早的 1 条没附上/)
  assert.equal(userWordsPart({ messages: [parent('p1', '2026-11-21T08:00:00Z', [])] }), '')
})
