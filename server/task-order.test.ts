import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askedAt, byAskedAt, taskSummary } from '../shared/task.ts'
import type { Task } from '../shared/schema.ts'

// 任务列表按用户最近发消息的时间排，Agent 回复（updatedAt 变了）不影响顺序
const msg = (role: 'user' | 'agent', at: string) => ({ id: at, role, agentId: '', step: '', text: '', tools: [], at })
const task = (id: string, createdAt: string, updatedAt: string, messages: ReturnType<typeof msg>[]) =>
  ({ id, createdAt, updatedAt, messages, queue: [] }) as unknown as Task

test('取用户最近一条消息的时间，没有就用创建时间', () => {
  const a = task('a', '2026-10-19T01:00:00Z', '2026-10-19T09:00:00Z', [
    msg('user', '2026-10-19T01:00:00Z'),
    msg('user', '2026-10-19T03:00:00Z'),
    msg('agent', '2026-10-19T09:00:00Z'),
  ])
  assert.equal(askedAt(a), '2026-10-19T03:00:00Z')
  assert.equal(askedAt(task('b', '2026-10-19T02:00:00Z', '2026-10-19T02:00:00Z', [])), '2026-10-19T02:00:00Z')
})

test('Agent 刚回复的任务不排到前面', () => {
  const replied = task('replied', '2026-10-19T01:00:00Z', '2026-10-19T09:00:00Z', [
    msg('user', '2026-10-19T01:00:00Z'),
    msg('agent', '2026-10-19T09:00:00Z'),
  ])
  const asked = task('asked', '2026-10-19T02:00:00Z', '2026-10-19T02:00:00Z', [msg('user', '2026-10-19T02:00:00Z')])
  assert.deepEqual(
    [replied, asked].sort(byAskedAt).map((t) => t.id),
    ['asked', 'replied'],
  )
})

test('列表摘要去掉了后面的消息，仍按最近一条用户消息的时间', () => {
  const full = {
    ...task('a', '2026-10-19T01:00:00Z', '2026-10-19T09:00:00Z', [
      msg('user', '2026-10-19T01:00:00Z'),
      msg('user', '2026-10-19T05:00:00Z'),
    ]),
    steps: [],
    workflows: [],
  } as unknown as Task
  const s = taskSummary(full)
  assert.equal(s.messages.length, 1)
  assert.equal(askedAt(s), '2026-10-19T05:00:00Z')
})
