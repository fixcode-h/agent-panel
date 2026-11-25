/**
 * 流程图里选中节点直接发消息的判定和改动（shared/flow/node-message.ts）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task, TaskStep } from '../schema.ts'
import { FlowRun } from '../tasks/flow-schema.ts'
import { nodeMessagePlan, noteForNode, rerunFromNode } from './node-message.ts'

const step = (id: string, status: TaskStep['status'], o: Partial<TaskStep> = {}) =>
  ({ id, nodeId: id, title: id, status, parentId: '', verdict: '', branch: '', endedAt: '', ...o }) as TaskStep

const run = (steps: TaskStep[], phase: FlowRun['phase'] = 'running') =>
  ({
    status: 'running',
    steps,
    flowRun: FlowRun.parse({ owner: 'p', workflowName: 'w', kind: 'change', input: 'x', phase }),
  }) as Pick<Task, 'status' | 'steps' | 'flowRun'>

test('按节点状态决定怎么交：在跑插话、等确认修改、没开始带上、做完退回重跑', () => {
  const tk = run([
    step('plan', 'done'),
    step('impl', 'running'),
    step('check', 'pending'),
    step('ask', 'running', { awaitConfirm: true }),
  ])
  const kind = (id: string) => {
    const p = nodeMessagePlan(tk, id)
    return 'error' in p ? p.error : p.kind
  }
  assert.equal(kind('impl'), 'steer')
  assert.equal(kind('ask'), 'revise')
  assert.equal(kind('check'), 'note')
  assert.equal(kind('plan'), 'rerun')
  assert.ok('error' in nodeMessagePlan(tk, 'nope'))
})

test('结束了的运行、不是运行的任务都不能直接发给节点', () => {
  assert.ok('error' in nodeMessagePlan(run([step('a', 'done')], 'done'), 'a'))
  assert.ok('error' in nodeMessagePlan({ steps: [step('a', 'done')] }, 'a'))
})

test('退回重跑：这个节点和之后的改回待执行，意见记成用户退回', () => {
  const tk = run(
    [step('plan', 'done'), step('impl', 'done'), step('impl/step/a', 'done', { parentId: 'impl' })],
    'ready',
  )
  const n = rerunFromNode(tk, tk.steps[1], '改用订阅', '2026-11-25T00:00:00Z')
  assert.equal(n, 1)
  assert.deepEqual(
    tk.steps.map((s) => s.status),
    ['done', 'pending', 'pending'],
  )
  assert.equal(tk.flowRun!.phase, 'running')
  assert.deepEqual(tk.flowRun!.decisions.at(-1), {
    at: '2026-11-25T00:00:00Z',
    node: 'impl',
    kind: 'back',
    text: '改用订阅',
  })
})

test('给没开始的节点：记成点名给它的补充说明', () => {
  const tk = run([step('plan', 'running'), step('impl', 'pending')])
  noteForNode(tk, tk.steps[1], '别动接口', 'now')
  assert.deepEqual(tk.flowRun!.decisions.at(-1), { at: 'now', node: 'impl', kind: 'note', text: '别动接口' })
})
