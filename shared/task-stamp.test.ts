import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskMessage } from './schema.ts'
import { messageStamp } from './task.ts'

const ask = (answer?: string): TaskMessage =>
  ({
    id: 'm1',
    role: 'system',
    agentId: '',
    step: '',
    text: '子对话请你决定',
    tools: [],
    at: '2026-10-22T00:00:00.000Z',
    panel: 'ask',
    ask: { from: 'c1', title: '子对话', question: '怎么做？', options: [], kind: 'question', answer },
  }) as TaskMessage

test('提问被回答后指纹要变：不然卡片在别的页面答完仍是「待决定」', () => {
  assert.notEqual(messageStamp(ask()), messageStamp(ask('按 A 做')))
  assert.notEqual(messageStamp(ask('按 A 做')), messageStamp(ask('按 B 做')))
})

test('没有提问的消息指纹不受影响，普通消息输出变化照样能认出来', () => {
  const base = { id: 'm2', role: 'agent', agentId: '', step: '', thinking: '', error: '', text: '回复', tools: [] }
  const a = {
    ...base,
    at: '',
    tools: [{ kind: 'run', name: '', label: '', detail: '', output: '一' }],
  } as unknown as TaskMessage
  const b = {
    ...base,
    at: '',
    tools: [{ kind: 'run', name: '', label: '', detail: '', output: '一二' }],
  } as unknown as TaskMessage
  assert.notEqual(messageStamp(a), messageStamp(b))
})
