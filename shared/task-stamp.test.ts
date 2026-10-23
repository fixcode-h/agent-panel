import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskMessage } from './schema.ts'
import { delegatePrompt, messageStamp } from './task.ts'

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

test('交给父对话决定后指纹要变：不然卡片一直停在「等你选择」', () => {
  const plain = ask()
  const delegated = { ...plain, ask: { ...plain.ask!, delegated: true } } as TaskMessage
  assert.notEqual(messageStamp(plain), messageStamp(delegated))
  // 没叫起父对话时卡片要显示原因：这也得推给页面，刷新后原因不能丢
  const failed = { ...delegated, ask: { ...delegated.ask!, delegatedError: '父对话正在执行' } } as TaskMessage
  assert.notEqual(messageStamp(delegated), messageStamp(failed))
})

test('交给父对话决定时把问题全文和选项一起交给它：续上等下一句的调用不会重读收件箱', () => {
  const text = delegatePrompt({ from: 'c1', title: '子对话', question: '用 A 还是 B？', options: ['A 方案', 'B 方案'] })
  assert.match(text, /用 A 还是 B？/, '带问题全文')
  assert.match(text, /1\. A 方案/, '带选项')
  assert.match(text, /2\. B 方案/)
  assert.match(text, /send_to_conversation/, '告诉它用哪个工具交给子对话')
  assert.match(text, /c1/, '带上子对话 id')
  assert.doesNotMatch(delegatePrompt({ from: 'c1', title: 't', question: 'q', options: [] }), /可选的做法/)
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
