import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newTask, withTaskModel } from '../shared/task.ts'
import { DEFAULT_AGENT_ID } from '../shared/schema.ts'

const input = (agentId: string) => ({
  projectId: 'p',
  mode: 'chat' as const,
  workflowId: '',
  agentId,
  cli: 'codex',
  model: 'gpt-5',
  effort: 'high',
  params: {},
  prompt: 'x',
  attachments: [],
  isolate: false,
  askUser: false,
})

test('新建对话：不用 Agent 角色（空 agentId）时也记住选的 CLI、模型和思考强度', () => {
  for (const agentId of ['', DEFAULT_AGENT_ID]) {
    const t = newTask(input(agentId), undefined, new Date(0).toISOString(), 'm')
    assert.deepEqual({ cli: t.cli, model: t.model, effort: t.effort }, { cli: 'codex', model: 'gpt-5', effort: 'high' })
  }
  // 换成有自己配置的 Agent 时，用 Agent 的，不跟输入框的选择走
  const own = newTask(input('mine'), undefined, new Date(0).toISOString(), 'm')
  assert.deepEqual({ cli: own.cli, model: own.model, effort: own.effort }, { cli: '', model: '', effort: '' })
})

test('对话的执行配置：不用 Agent 角色时按任务里选的 CLI 和模型', () => {
  const task = { mode: 'chat', agentId: '', cli: 'codex', model: 'gpt-5', effort: 'high' }
  const def = { id: 'mine', cli: 'claude', model: 'sonnet', effort: 'low' }
  // 不用 Agent 角色时传进来的是 id 为空的默认 Agent 配置，要换成任务里选的
  assert.deepEqual(withTaskModel({ ...def, id: '' }, task), {
    id: '',
    cli: 'codex',
    model: 'gpt-5',
    effort: 'high',
  })
  // 有自己配置的 Agent 不受影响
  assert.equal(withTaskModel(def, { ...task, agentId: 'mine' }), def)
})
