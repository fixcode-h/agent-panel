import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetLimit, finish, overBudget, runConversationTurn, type EngineHost } from './engine.ts'
import { Task, TaskStep } from './schema.ts'

test('执行上限：工作流和计划都设了时取小的那个，0 和不设都按不限', () => {
  assert.equal(budgetLimit(undefined, 0), null)
  assert.deepEqual(budgetLimit(undefined, 5000), { value: 5000, by: 'plan' })
  assert.deepEqual(budgetLimit(8000, 0), { value: 8000, by: 'workflow' })
  // 谁先到都算超：停的时候要按生效的那个上限解释，用户才知道去哪里改
  assert.deepEqual(budgetLimit(8000, 5000), { value: 5000, by: 'plan' })
  assert.deepEqual(budgetLimit(5000, 8000), { value: 5000, by: 'workflow' })
  // 相等时按工作流：那是更早的设定，提示里说的也是它
  assert.deepEqual(budgetLimit(5000, 5000), { value: 5000, by: 'workflow' })
  // 0 当不限：不会因为有人填了 0 就把所有执行判成超
  assert.equal(budgetLimit(0, 0), null)
})

test('超过预算停下：状态是 stopped、已有消息一条不丢、提示挂上「预算」这一类', () => {
  const iso = new Date().toISOString()
  const task = Task.parse({
    id: 'task-1',
    createdAt: iso,
    updatedAt: iso,
    projectId: '',
    title: '跑构建',
    mode: 'chat',
    status: 'running',
    messages: [
      { id: 'm1', role: 'user', agentId: '', step: '', text: '把构建跑完', tools: [], at: iso },
      { id: 'm2', role: 'agent', agentId: '', step: '', text: '已经改好两个文件', tools: [], at: iso },
    ],
    steps: [TaskStep.parse({ id: 'n1', title: '构建', status: 'running', startedAt: iso })],
  })
  const host = {
    task,
    workflow: undefined,
    newId: () => `sys-${task.messages.length}`,
    changed: () => {},
  } as unknown as EngineHost

  finish(host, { ok: false, stopped: true, budget: true, error: '这次执行已经用了 5000 token，达到计划设定的上限。' })

  assert.equal(task.status, 'stopped')
  // 已经产出的内容都留着：用户能看到做到哪一步
  assert.deepEqual(
    task.messages.slice(0, 2).map((m) => m.id),
    ['m1', 'm2'],
  )
  // 停下时补一条说明，归类到「超过执行上限」而不是当成执行失败
  const last = task.messages.at(-1)
  assert.equal(last?.role, 'system')
  assert.equal(last?.alert?.kind, 'budget')
  assert.match(last?.text ?? '', /5000 token/)
  // 被打断的步骤回到待执行，下次继续执行接着做；不算失败
  assert.equal(task.steps[0].status, 'pending')
})

test('聊天模式的执行上限：token 和时长超了都给出能读懂的说明', () => {
  const iso = new Date().toISOString()
  const host = (over: Record<string, unknown> = {}) => {
    const task = Task.parse({
      id: 'task-1',
      createdAt: iso,
      updatedAt: iso,
      projectId: '',
      title: '跑构建',
      mode: 'chat',
      status: 'running',
      messages: [],
    })
    Object.assign(task, over)
    return { task, workflow: undefined } as unknown as EngineHost
  }

  // token：计划设了 1000，用量按这一轮开始时起算
  const tokens = host({
    budgetTokens: 1000,
    usage: { agents: {}, inputTokens: 800, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    budgetFrom: { usd: 0, tokens: 0, at: Date.now() },
  })
  const tokenMsg = overBudget(tokens)
  assert.match(tokenMsg, /计划设定的上限/)
  assert.ok(tokenMsg.includes((1000).toLocaleString()), '说明里要写出上限是多少')

  // 没超：返回空字符串，不能误停
  assert.equal(
    overBudget(
      host({
        budgetTokens: 1000,
        usage: { agents: {}, inputTokens: 300, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
        budgetFrom: { usd: 0, tokens: 0, at: Date.now() },
      }),
    ),
    '',
  )

  // 时长：从这一轮开始算（budgetFrom.at），超过就停
  const minutes = host({ budgetMinutes: 30, budgetFrom: { usd: 0, tokens: 0, at: Date.now() - 31 * 60_000 } })
  assert.match(overBudget(minutes), /计划设定的上限 30 分钟/)
  // 旧任务没有开始时刻：按不限处理，不能一上来就判超
  assert.equal(overBudget(host({ budgetMinutes: 30, budgetFrom: { usd: 0, tokens: 0 } })), '')
})

test('聊天模式：计划设了 token 上限，一开跑就停，不调用 Agent 也不丢已有消息', async () => {
  const iso = new Date().toISOString()
  const task = Task.parse({
    id: 'task-chat',
    createdAt: iso,
    updatedAt: iso,
    projectId: '',
    title: '跑构建',
    mode: 'chat',
    status: 'running',
    messages: [{ id: 'm1', role: 'user', agentId: '', step: '', text: '把构建跑完', tools: [], at: iso }],
    budgetTokens: 100,
    usage: { agents: {}, inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  })
  task.budgetFrom = { usd: 0, tokens: 0, at: Date.now() }
  let called = false
  const host = {
    task,
    agents: [],
    prompt: '把构建跑完',
    newId: () => `id-${task.messages.length}`,
    changed: () => {},
    runAgent: async () => {
      called = true
      return { ok: true, text: '' }
    },
  } as unknown as EngineHost

  await runConversationTurn(host, '')

  assert.equal(called, false, '超过上限时不应该再调 CLI 跑下一圈')
  assert.equal(task.status, 'stopped')
  // 已有输出保留，停在预算提示上
  assert.equal(task.messages[0].id, 'm1')
  assert.equal(task.messages.at(-1)?.alert?.kind, 'budget')
})

test('聊天轮次不读工作流预算：对话里跑过工作流之后，工作流上限不该停掉普通聊天', () => {
  const iso = new Date().toISOString()
  const task = Task.parse({
    id: 'task-chat',
    createdAt: iso,
    updatedAt: iso,
    projectId: '',
    title: '跑构建',
    mode: 'chat',
    status: 'running',
    messages: [],
    usage: { agents: {}, inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1 },
  })
  task.budgetFrom = { usd: 0, tokens: 0, at: Date.now() }
  // 对话里跑过 start_plan 之后任务会一直带着工作流快照（host.workflow 非空）
  const host = {
    task,
    workflow: { budgetTokens: 100, budgetUsd: 0 },
  } as unknown as EngineHost

  // 节点执行路径照旧受工作流预算约束
  assert.match(overBudget(host), /工作流设定的上限/)
  // 聊天轮次只按计划设的上限：工作流那份额度不该管普通聊天
  assert.equal(overBudget(host, false), '')
})
