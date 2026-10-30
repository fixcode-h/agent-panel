import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost } from '../shared/engine.ts'

/**
 * 流程停在某个节点的结论上（前置检查不通过）后，用户发要求（例如总结卡「要你处理」的「处理」按钮）：
 * 先交给主角色处理，处理完从停住的节点重新检查，通过后接着走后面的节点（用户 2026-10-30）
 */
const agent = (id: string, name: string): Agent => ({ ...AgentInput.parse({ name }), id, createdAt: '', updatedAt: '' })
const agents = [agent('m', '主管'), agent('w', '开发')]

const w = Workflow.parse({
  id: 'wf',
  createdAt: '',
  updatedAt: '',
  name: '先检查再做',
  mainAgentId: 'm',
  dispatch: false,
  flows: [
    {
      id: 'main',
      name: '主流程',
      nodes: [
        { id: 'check', title: '前置检查', agentId: 'w', instructions: '检查环境。' },
        { id: 'impl', title: '实现', agentId: 'w', instructions: '实现。' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'check' },
        { id: 'e2', from: 'check', to: 'impl', when: 'pass' },
        { id: 'e3', from: 'impl', to: 'end' },
      ],
    },
  ],
})

test('流程停在前置检查上：用户发要求后主角色先处理，处理完从停住的节点重新检查并接着走流程', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't'),
    id: 't',
  } as Task
  const log: AgentCall[] = []
  let checks = 0
  let n = 0
  const host: EngineHost = {
    task,
    agents,
    workflows: [w],
    workflow: w,
    prompt: '做功能',
    changed: () => {},
    newId: () => `id${++n}`,
    runAgent: async (call) => {
      log.push(call)
      if (call.step?.id === 'check')
        return { ok: true, text: ++checks === 1 ? '缺配置。\n\n结论：不通过' : '结论：通过' }
      if (call.step?.id === 'impl') return { ok: true, text: '做完了' }
      return { ok: true, text: '已补上配置' }
    },
  }
  await runEngineTurn(host)
  const step = (id: string) => task.steps.find((s) => s.id === id)!
  assert.equal(step('check').branch, 'fail')
  assert.equal(step('impl').status, 'skipped')

  // 用户点了「处理」：新的一轮
  const ask = '请直接处理：补上配置'
  task.messages.push({ id: 'u2', role: 'user', agentId: '', step: '', text: ask, tools: [], at: '' })
  host.prompt = ask
  log.length = 0
  await runEngineTurn(host)

  // 主角色先处理，提示里说清处理完会重新检查
  assert.equal(log[0].sessionKey, 'm')
  assert.match(log[0].prompt, /补上配置/)
  assert.match(log[0].prompt, /重新执行「前置检查」/)
  // 然后从停住的节点重新检查，通过后接着走后面的节点
  assert.deepEqual(
    log.slice(1).map((c) => c.step?.id),
    ['check', 'impl'],
  )
  assert.equal(step('check').branch, 'pass')
  assert.equal(step('impl').status, 'done')
  assert.equal(task.status, 'done')
})
