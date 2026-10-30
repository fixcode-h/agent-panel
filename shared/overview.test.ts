/**
 * 对话总览的分组：等你处理 / 停住了 / 执行中 / 最近，子对话算进父对话。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { overviewRows } from './overview.ts'
import { Task } from './schema.ts'

const at = '2026-10-01T00:00:00.000Z'
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({ id, projectId: 'p', title: id, mode: 'chat', status: 'done', createdAt: at, updatedAt: at, ...extra })
const plan = {
  id: 'pl',
  title: '',
  createdAt: at,
  doneAt: '',
  steps: [
    { id: 'a', title: 'a', status: 'done' },
    { id: 'b', title: 'b', status: 'pending' },
  ],
}

test('分组：失败的等你处理，计划没做完又没在跑的算停住了（用户自己停的不算），子对话只算进父对话', () => {
  const rows = overviewRows([
    task('failed', { status: 'failed' }),
    task('stalled', { plans: [plan] }),
    task('paused', { plans: [plan], status: 'stopped', stopReason: 'user' }),
    task('busy', { status: 'running', working: true, usage: { inputTokens: 10, outputTokens: 5 } }),
    task('kid', {
      parentTaskId: 'busy',
      status: 'running',
      working: true,
      usage: { inputTokens: 100, outputTokens: 0 },
    }),
    task('archived', { archived: true }),
  ])
  const by = Object.fromEntries(rows.map((r) => [r.task.id, r]))
  assert.deepEqual(Object.keys(by).sort(), ['busy', 'failed', 'paused', 'stalled'])
  assert.equal(by.failed.group, 'you')
  assert.equal(by.stalled.group, 'stalled')
  assert.deepEqual(by.stalled.plan, { done: 1, total: 2 })
  assert.equal(by.paused.group, 'rest')
  assert.equal(by.busy.group, 'running')
  assert.equal(by.busy.kidsBusy, 1)
  assert.equal(by.busy.tokens, 115)
  // 按组排：等你处理在前
  assert.deepEqual(
    rows.map((r) => r.group),
    ['you', 'stalled', 'running', 'rest'],
  )
})
