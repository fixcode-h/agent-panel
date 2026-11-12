import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newTask } from '../shared/task.ts'
import { withTaskModel } from '../shared/task-run.ts'
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
  // 用角色的对话：模型、强度用角色的；接口传的 CLI 记下来，跟随默认 CLI 的角色按它跑（见下面 withTaskModel）
  const own = newTask(input('mine'), undefined, new Date(0).toISOString(), 'm')
  assert.deepEqual({ cli: own.cli, model: own.model, effort: own.effort }, { cli: 'codex', model: '', effort: '' })
})

test('对话的 CLI 定下来后不跟着默认 CLI 换（实测报告问题 7）', () => {
  const follow = { id: 'r', cli: '', model: '@high', effort: '' }
  const chat = { mode: 'chat', agentId: 'r', cli: '', model: '', effort: '' }
  // 还没运行过：跟随默认（cli 空，交给 agentRun 取默认 CLI）
  assert.equal(withTaskModel(follow, chat), follow)
  // 跑过一轮、会话在 Claude Code 上：之后按 Claude Code，模型档位仍用角色的
  assert.deepEqual(withTaskModel(follow, { ...chat, sessionCli: 'claude' }), { ...follow, cli: 'claude' })
  // 新建时接口传了 CLI：跟随默认的角色按它跑
  assert.deepEqual(withTaskModel(follow, { ...chat, cli: 'codex', sessionCli: 'claude' }), { ...follow, cli: 'codex' })
  // 角色自己指定了 CLI：按角色的（改角色是用户主动换）
  const fixed = { ...follow, cli: 'pi' }
  assert.equal(withTaskModel(fixed, { ...chat, cli: 'codex', sessionCli: 'claude' }), fixed)
  // 不用角色的对话：没选过 CLI 时也按会话所在的 CLI
  const none = { id: '', cli: '', model: '', effort: '' }
  assert.equal(withTaskModel(none, { ...chat, agentId: '', sessionCli: 'codex' }).cli, 'codex')
  // 工作流任务不受影响
  assert.equal(withTaskModel(follow, { ...chat, mode: 'workflow', sessionCli: 'claude' }), follow)
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
