import assert from 'node:assert/strict'
import test from 'node:test'
import { autoSubmit } from './submit-test-kit.ts'
import { FlowRun } from '../shared/tasks/flow-schema.ts'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn } from '../shared/engine/index.ts'
import type { AgentCall, EngineHost } from '../shared/engine/host.ts'

/** 起运行时说好跳过的节点（FlowRun.skip，复盘 2026-11-25 B2）：不调 Agent、记成完成，下游照常跑并知道它是跳过的 */
const agent = (id: string, name: string): Agent => ({ ...AgentInput.parse({ name }), id, createdAt: '', updatedAt: '' })

test('跳过的节点不调 Agent、记成完成；下游拿到「跳过了」的说明，条件分支按通过走', async () => {
  const w = Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '规范',
    mainAgentId: 'm',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'design', title: '设计与压测', agentId: 'm', instructions: '设计。' },
          { id: 'impl', title: '实现', agentId: 'm', instructions: '实现。' },
          { id: 'redo', title: '重做', agentId: 'm', instructions: '重做。' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'design' },
          { id: 'e2', from: 'design', to: 'impl', when: 'pass' },
          { id: 'e3', from: 'design', to: 'redo', when: 'fail' },
          { id: 'e4', from: 'impl', to: 'end' },
          { id: 'e5', from: 'redo', to: 'end' },
        ],
      },
    ],
  })
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't'),
    flowRun: FlowRun.parse({ owner: 'p', skip: ['design'] }),
    id: 't',
  } as Task
  const log: AgentCall[] = []
  let n = 0
  const host: EngineHost = {
    task,
    agents: [agent('m', '开发')],
    workflows: [w],
    workflow: w,
    prompt: '做功能',
    changed: () => {},
    newId: () => `id${++n}`,
    runAgent: async (call) => {
      autoSubmit(call)
      log.push(call)
      return { ok: true, text: '做完了' }
    },
  }
  await runEngineTurn(host)
  assert.deepEqual(
    log.map((c) => c.step?.id),
    ['impl'],
  )
  assert.equal(task.steps.find((s) => s.id === 'design')?.status, 'done')
  assert.equal(task.steps.find((s) => s.id === 'redo')?.status, 'skipped')
  assert.match(log[0].prompt, /跳过了/)
})
