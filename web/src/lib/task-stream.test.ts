/**
 * 服务端推送过来的任务增量怎么合到当前任务上：任务本身整体替换，消息按 id 替换或追加。
 * 合错会让对话里重复显示同一条回复或者丢掉一段输出，所以这段单独测。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Task, TaskMessage } from '@shared/schema'
import { mergePatch } from '@/lib/task-stream'

const msg = (id: string, text: string) => ({ id, role: 'agent', text }) as TaskMessage
const task = (messages: TaskMessage[], title = '任务') => ({ id: 't1', title, messages }) as unknown as Task
type Patch = { meta: Omit<Task, 'messages'>; messages: TaskMessage[]; total: number }
const patch = (messages: TaskMessage[], title = '任务'): Patch => ({
  meta: { id: 't1', title } as Omit<Task, 'messages'>,
  messages,
  total: messages.length,
})

test('mergePatch：没见过的消息按顺序追加到最后', () => {
  const out = mergePatch(task([msg('a', '一')]), patch([msg('a', '一'), msg('b', '二')]))
  assert.deepEqual(
    out.messages.map((m) => m.id),
    ['a', 'b'],
  )
})

test('mergePatch：同一个 id 原地替换，顺序不变', () => {
  const before = task([msg('a', '一'), msg('b', '二')])
  const out = mergePatch(before, patch([msg('b', '二改')]))
  assert.deepEqual(
    out.messages.map((m) => m.text),
    ['一', '二改'],
  )
})

test('mergePatch：流式输出时同一条回复被反复替换，只在末尾留一份', () => {
  let out = task([])
  for (const text of ['你', '你好', '你好世界']) out = mergePatch(out, patch([msg('a', text)]))
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].text, '你好世界')
})

test('mergePatch：任务本身换成推送里的那份', () => {
  const out = mergePatch(task([msg('a', '一')], '旧标题'), patch([], '新标题'))
  assert.equal(out.title, '新标题')
  assert.equal(out.messages.length, 1, '没有新消息时保留原来的消息')
})

test('mergePatch：不改动传进来的任务', () => {
  const before = task([msg('a', '一')])
  mergePatch(before, patch([msg('b', '二')]))
  assert.equal(before.messages.length, 1)
})
