/**
 * 旧任务里的 queue（以前执行中排队的追加要求）：读出来时并进对话、然后清掉字段；
 * 单条坏数据不能把整个任务丢掉。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../shared/i18n.ts'
import { Task } from '../shared/schema.ts'

setLang('zh')

const base = (extra: Record<string, unknown>) => ({
  id: 't1',
  projectId: '',
  title: '旧任务',
  mode: 'chat',
  status: 'done',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  messages: [
    { id: 'u1', role: 'user', agentId: '', step: '', text: '原来的要求', tools: [], at: '2026-10-01T00:00:00.000Z' },
    { id: 'a1', role: 'agent', agentId: '', step: '', text: '做完了', tools: [], at: '2026-10-01T00:01:00.000Z' },
  ],
  ...extra,
})

test('旧数据里的普通排队要求：补到对话末尾，原文、附件和时间都保留', () => {
  const t = Task.parse(
    base({
      queue: [
        {
          id: 'q1',
          text: '再改一下',
          attachments: [{ name: 'a.txt', path: '/tmp/a.txt', size: 3, mime: 'text/plain' }],
          at: '2026-10-01T00:02:00.000Z',
          note: false,
        },
      ],
    }),
  )
  assert.equal('queue' in t, false, '清掉 queue 字段')
  const last = t.messages.at(-1)!
  assert.equal(last.text, '再改一下')
  assert.equal(last.role, 'user')
  assert.equal(last.at, '2026-10-01T00:02:00.000Z', '保留原来的时间')
  assert.equal(last.attachments?.[0].name, 'a.txt')
  assert.equal(t.messages.length, 3)
})

test('旧数据里等 CLI 取走的补充（note）：已经不成立，丢弃', () => {
  const t = Task.parse(
    base({
      queue: [{ id: 'q1', text: '还没取走的补充', attachments: [], at: '2026-10-01T00:02:00.000Z', note: true }],
    }),
  )
  assert.equal(
    t.messages.some((m) => m.text === '还没取走的补充'),
    false,
  )
  assert.equal(t.messages.length, 2)
})

test('旧数据里有一条坏掉的排队消息：不要整个任务失败', () => {
  const t = Task.parse(
    base({
      queue: [
        { id: 'bad', text: 42 },
        { id: 'q2', text: '这条要留下', attachments: [], at: '2026-10-01T00:03:00.000Z' },
      ],
    }),
  )
  assert.equal(t.messages.at(-1)!.text, '这条要留下')
  assert.equal(t.messages.length, 3)
})

test('没有 queue 的旧任务照常读出来', () => {
  const t = Task.parse(base({}))
  assert.equal(t.messages.length, 2)
})
