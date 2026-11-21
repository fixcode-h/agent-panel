/**
 * 父对话转述用户的话：按 id 取原话（只认用户亲口发的），"last" 取最近一条，附进交给子对话的正文。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { quotesOf, withQuotes } from './quote.ts'
import type { TaskMessage } from '../schema.ts'

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
const msgs = [
  m('u1', 'user', '暴露获取PlotActor就行吧'),
  m('a1', 'agent', '收到'),
  m('c1', 'user', '子对话的汇报', {
    peer: { id: 'k', title: '', name: '', rel: 'child', kind: 'report', subject: '' },
  }),
  m('u2', 'user', 'bool USPHomeDecorationFunctionLibrary::GetDecorationActorTopLocation 这个函数'),
]

test('按 id 取用户原话，"last" 是用户最近一条', () => {
  const r = quotesOf(msgs, ['u1', 'last'])
  assert.ok('said' in r)
  assert.deepEqual(
    r.said.map((x) => x.id),
    ['u1', 'u2'],
  )
})

test('不是用户亲口发的（Agent 回复、子对话汇报、不存在的 id）退回并说清怎么写', () => {
  for (const bad of ['a1', 'c1', 'nope']) {
    const r = quotesOf(msgs, [bad])
    assert.ok('error' in r)
    assert.match(r.error, /不是用户在这个对话里发的消息/)
  }
})

test('交给子对话的正文后面附上原话', () => {
  const r = quotesOf(msgs, ['u2'])
  assert.ok('said' in r)
  const text = withQuotes('用户调整了修法，按下面原话重新评估', r.said)
  assert.match(text, /用户在父对话里的原话/)
  assert.match(text, /> bool USPHomeDecorationFunctionLibrary::GetDecorationActorTopLocation 这个函数$/)
  assert.equal(withQuotes('原样', []), '原样')
})
