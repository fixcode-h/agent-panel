import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskData, type Task } from '@shared/schema'
import { taskLiveOf } from '@shared/live/task-live'
import { inProgress } from './in-progress'

const plan = {
  plans: [
    {
      id: 'p1',
      createdAt: '',
      doneAt: '',
      steps: [
        { id: 'a', title: '设计', status: 'done' },
        { id: 'b', title: '实现', status: 'running' },
      ],
    },
  ],
}
const task = (over: Record<string, unknown> = {}) =>
  ({ ...TaskData.parse({ projectId: 'p', title: 't', mode: 'chat', status: 'done', ...over }), id: 't' }) as Task
const rt = { cliAlive: false, jobs: [], childrenWorking: 0, childrenCli: 0, childrenNeeds: 0 }
const has = (tk: Task, more = {}) => inProgress(tk, taskLiveOf(tk, { ...rt, ...more }))
const nudged = {
  id: 'w',
  role: 'system',
  agentId: '',
  step: '',
  text: '推满了',
  tools: [],
  at: '',
  alert: { level: 'warn', detail: '', kind: 'unfinished' },
}

test('侧栏「进行中」：执行中、等你处理、失败、计划卡住都算；只是未完成、已完成的不算（用户 2026-11-26 选并进「进行中」）', () => {
  assert.ok(has(task({ status: 'running', working: true })))
  assert.ok(has(task(), { runsWorking: 1 }), '名下工作流在跑')
  assert.ok(has(task({ requests: [{ id: 'q', kind: 'confirm', title: '确认', detail: '', at: '' }] })))
  assert.ok(has(task({ status: 'failed' })), '失败')
  assert.ok(has(task({ ...plan, messages: [nudged] })), '计划卡住：面板推满了还停着')
  assert.ok(!has(task(plan)), '只是未完成：面板还会推它接着做')
  assert.ok(!has(task()), '已完成')
  assert.ok(!has(task({ status: 'stopped', stopReason: 'user' })), '用户自己停的')
})
