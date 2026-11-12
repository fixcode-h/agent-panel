/**
 * 上下文占用记在哪（usage-record.ts）：对话里的子任务和对话同一个角色时，不能写角色那一条。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task, TaskStep } from '../../shared/schema.ts'
import { agentUsage, contextUsage } from './usage-record.ts'

const taskOf = (mode: Task['mode']) => ({ mode, usage: { agents: {} } }) as unknown as Task
const step = { id: 's1', usage: { context: 0, window: 200_000, model: 'm-small' } } as unknown as TaskStep

test('对话里的子任务：上下文记在自己身上，对话那一条不跟着跳', () => {
  const task = taskOf('chat')
  const au = () => agentUsage(task, 'dev', 'm-big', 1_000_000)
  au().context = 87_700
  const sub = contextUsage(task, step, au)
  sub().context = 230_000
  sub().window = 200_000
  assert.equal(task.usage.agents.dev.context, 87_700)
  assert.equal(task.usage.agents.dev.window, 1_000_000)
  // 同一次调用里拿到的是同一份
  assert.equal(sub().context, 230_000)
  // 对话自己的调用照旧写角色那一条
  assert.equal(contextUsage(task, undefined, au)(), task.usage.agents.dev)
})

test('工作流的节点：会话栏按节点找角色，仍记在角色上', () => {
  const task = taskOf('workflow')
  const au = () => agentUsage(task, 'dev', 'm', 200_000)
  contextUsage(task, step, au)().context = 5_000
  assert.equal(task.usage.agents.dev.context, 5_000)
})
