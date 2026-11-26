import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteGrant, TaskMessage, ToolUse } from '../schema.ts'
import { grantNotes } from './notes.ts'

const at = '2026-11-26T10:00:00.000Z'
const note = (id: string, grant: Partial<NoteGrant> = {}, step = ''): TaskMessage => ({
  id,
  role: 'system',
  agentId: '',
  step,
  text: '按这个对话的放行规则自动允许',
  tools: [],
  at,
  grant: { via: 'rule', rule: 'ctool:project:x', label: '自建工具「x」', title: 'python x.py', ...grant },
})
const agent = (id: string, tools: Partial<ToolUse>[] = []): TaskMessage => ({
  id,
  role: 'agent',
  agentId: 'a',
  step: '',
  text: '',
  tools: tools.map((t) => ({ kind: 'other', label: 'custom_tool', detail: '', ...t })),
  at,
})
const user = (id: string): TaskMessage => ({ id, role: 'user', agentId: '', step: '', text: '继续', tools: [], at })

test('挂到工具卡片上的放行记录不单独显示', () => {
  const msgs = [note('n1'), agent('a1', [{ grant: { via: 'rule', label: 'x', note: 'n1' } }])]
  const v = grantNotes(msgs)
  assert.ok(v.hidden.has('n1'))
  assert.equal(v.runs.size, 0)
})

test('挂不上卡片的同一规则连续几条合成一行，中间隔着 Agent 回复也算连续', () => {
  const msgs = [note('n1'), agent('a1'), note('n2'), agent('a2'), note('n3')]
  const v = grantNotes(msgs)
  assert.deepEqual(
    v.runs.get('n1')?.map((m) => m.id),
    ['n1', 'n2', 'n3'],
  )
  assert.ok(v.hidden.has('n2') && v.hidden.has('n3') && !v.hidden.has('n1'))
})

test('用户发话、换了规则、换了来源都断开；你点的允许不合并也不藏', () => {
  const msgs = [
    note('n1'),
    user('u1'),
    note('n2'),
    note('n3', { rule: 'command:git' }),
    note('n4', { via: 'readonly', rule: undefined, label: '' }),
    note('d1', { via: 'user', always: true }),
  ]
  const v = grantNotes(msgs)
  assert.deepEqual([...v.runs.keys()], ['n1', 'n2', 'n3', 'n4'])
  assert.ok(!v.hidden.has('d1') && !v.runs.has('d1'))
})

test('旧消息没有 grant：不归这里管', () => {
  const old: TaskMessage = { ...note('o1'), grant: undefined }
  const v = grantNotes([old])
  assert.equal(v.hidden.size + v.runs.size, 0)
})
