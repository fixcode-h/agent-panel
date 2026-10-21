import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newTask, withTaskModel } from '../shared/task.ts'
import { LEGACY_DEFAULT_AGENT_ID, NewTaskInput, Task } from '../shared/schema.ts'

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
  // 以前的默认 Agent 去掉了：旧客户端传它的 id 时按「不用角色」处理
  for (const agentId of ['', LEGACY_DEFAULT_AGENT_ID]) {
    const t = newTask(NewTaskInput.parse(input(agentId)), undefined, new Date(0).toISOString(), 'm')
    assert.equal(t.agentId, '')
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

test('旧对话里记着默认 Agent：读出来改成不用角色，CLI 会话跟着搬过去', () => {
  const at = new Date(0).toISOString()
  const t = Task.parse({
    ...newTask(NewTaskInput.parse(input('')), undefined, at, 'm'),
    id: 't1',
    createdAt: at,
    updatedAt: at,
    agentId: LEGACY_DEFAULT_AGENT_ID,
    sessions: { [LEGACY_DEFAULT_AGENT_ID]: 'sess-1' },
  })
  assert.equal(t.agentId, '')
  assert.deepEqual(t.sessions, { '': 'sess-1' })
})
