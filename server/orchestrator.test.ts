import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost } from '../shared/engine.ts'

/**
 * 项目对话：Agent 在对话里直接执行，或者用 start_plan 按工作流执行一次计划；
 * 消耗的是 Agent 自己配置的能力（canPlan / canDelegate），不再有常驻编排器。
 */
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  ...AgentInput.parse({ name }),
  id,
  createdAt: '',
  updatedAt: '',
  ...extra,
})

const workflow = (): Workflow =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '执行计划',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'a', title: '实现', agentId: 'w', instructions: '写代码。' },
          { id: 'b', title: '验收', agentId: 'w', instructions: '验收。' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'b' },
          { id: 'e3', from: 'b', to: 'end' },
        ],
      },
    ],
  })

function host(task: Task, log: AgentCall[], runAgent: EngineHost['runAgent']): EngineHost {
  const w = workflow()
  const workers = [agent('w', '开发')]
  let n = 0
  return {
    task,
    agents: workers,
    workflows: [w],
    prompt: '做功能',
    changed: () => {},
    newId: () => `id${++n}`,
    workflowCatalog: () => [{ id: w.id, name: w.name, description: '', steps: ['实现', '验收'] }],
    resolveWorkflow: (id) => (id === w.id || !id ? { workflow: w, workflows: [w], skillSlots: {} } : undefined),
    runAgent: async (call) => {
      log.push(call)
      return runAgent(call)
    },
  }
}

test('对话里启动计划：同步跑完工作流，再把结果交回同一个会话', async () => {
  const w = workflow()
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '做功能' } as never, undefined, '', 't'),
    id: 't',
  } as Task
  const log: AgentCall[] = []
  let turn = 0
  const h = host(task, log, async (call) => {
    if (call.step) return { ok: true, text: `${call.step.title}好了` }
    if (turn++ === 0) {
      assert.match(call.prompt, /## 用户这次的消息\n做功能/)
      assert.equal(call.orch?.planning, true)
      assert.equal(call.orch?.coordinator, false)
      const r = call.orch!.plan(w.id, '做功能')
      assert.equal(r.ok, true)
      return { ok: true, text: '开始处理' }
    }
    // 工作流跑完：结果交回同一个会话；计划全部完成就结束了，不再追一轮要总结
    assert.match(call.prompt, /## 计划执行结果/)
    return { ok: true, text: '做完了' }
  })
  h.agents = [agent('m', '协调', { canPlan: true }), agent('w', '开发')]

  await runEngineTurn(h)
  assert.equal(task.status, 'done')
  assert.equal(task.plans.length, 1)
  assert.equal(task.plans[0].steps[0].run, 1)
  assert.equal(task.plans[0].summary, '', '不再写计划总结')
  assert.equal(task.runSeq, 1)
  assert.equal(task.runs.length, 1)
  assert.equal(task.runs[0].status, 'done')
  const steps = task.steps.filter((s) => s.runId === 1)
  assert.deepEqual(
    steps.map((s) => s.id),
    ['a', 'b'],
  )
  assert.ok(steps.every((s) => s.status === 'done'))
  assert.equal(
    task.steps.some((s) => s.kind === 'main'),
    false,
    '不再有常驻编排器',
  )
  const talks = log.filter((c) => !c.step)
  assert.equal(talks.length, 2, '对话一轮 + 计划结果一轮，不再追要总结')
  assert.equal(talks[1].sessionKey, 'm')
  assert.equal(log.filter((c) => !!c.step).length, 2, '两个节点各执行一次')
})

test('对话 Agent 没开「按工作流执行计划」：没有 start_plan 能力，直接回答', async () => {
  const task = {
    ...newTask(
      { projectId: 'p', mode: 'chat', agentId: 'm', prompt: '这个项目用什么语言' } as never,
      undefined,
      '',
      't2',
    ),
    id: 't2',
  } as Task
  const log: AgentCall[] = []
  const h = host(task, log, async (call) => {
    assert.equal(call.orch?.planning, false)
    assert.match(call.orch!.plan('', '做功能').info, /没有开启/)
    return { ok: true, text: '用的是 TypeScript。' }
  })
  h.agents = [agent('m', '协调', { canDelegate: true })]

  await runEngineTurn(h)
  assert.equal(task.runs.length, 0, '没有起运行')
  assert.equal(task.steps.length, 0, '没有执行流程节点')
  assert.equal(log.length, 1)
})

test('协调 Agent：一条消息只交给一个子对话，同一段话再发给别的子对话被拒绝', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '定成硬规则' } as never, undefined, '', 'p1'),
    id: 'p1',
  } as Task
  const log: AgentCall[] = []
  const sent: string[] = []
  const h = host(task, log, async (call) => {
    const rule = '【硬规则】截图失败就不下视觉结论'
    assert.equal((await call.orch!.sendToConversation('c1', rule)).ok, true)
    const again = await call.orch!.sendToConversation('c2', rule)
    assert.equal(again.ok, false)
    assert.match(again.info, /一条消息只交给一个子对话/)
    // 给同一个子对话补充、换一段话给别的子对话照常放行
    assert.equal((await call.orch!.sendToConversation('c1', rule)).ok, true)
    assert.equal((await call.orch!.sendToConversation('c2', '改按钮颜色')).ok, true)
    return { ok: true, text: '已交给最相关的子对话。' }
  })
  h.agents = [agent('m', '协调', { canDelegate: true })]
  h.listConversations = async () => []
  h.sendToConversation = async (id) => {
    sent.push(id)
    return { ok: true, info: `已交给「${id}」` }
  }

  await runEngineTurn(h)
  assert.deepEqual(sent, ['c1', 'c1', 'c2'])
})

test('协调 Agent：新建子对话并交给它，子对话自己不能再分派', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '实现登录' } as never, undefined, '', 'p1'),
    id: 'p1',
  } as Task
  const log: AgentCall[] = []
  const made: { title: string; message: string }[] = []
  const h = host(task, log, async (call) => {
    assert.equal(call.orch?.coordinator, true)
    // 父对话只统筹：不改文件、不开分支，收集到模块为止就交出去
    assert.match(call.prompt, /父对话只统筹，不动手/)
    assert.match(call.prompt, /不修改、新建或删除任何文件/)
    assert.match(call.prompt, /分派前只收集到模块为止/)
    assert.doesNotMatch(call.prompt, /可以自己当场改/)
    assert.match(await call.orch!.conversations(), /还没有子对话/)
    const r = await call.orch!.createConversation('登录改造', '实现登录，带手机号验证码')
    assert.equal(r.ok, true)
    return { ok: true, text: '已交给子对话。' }
  })
  h.agents = [agent('m', '协调', { canDelegate: true })]
  h.listConversations = async () => []
  h.createConversation = async ({ title, message }) => {
    made.push({ title, message })
    return { ok: true, id: 'c1', title, info: '已新建' }
  }

  await runEngineTurn(h)
  assert.deepEqual(made, [{ title: '登录改造', message: '实现登录，带手机号验证码' }])
  // 新建子对话不再另记居中的系统提示：工具调用本身显示成「新建子对话 登录改造」
  assert.ok(!task.messages.some((m) => m.role === 'system' && /新建了子对话/.test(m.text)))
  assert.equal(log.length, 1)

  // 子对话里即使 Agent 配了 canDelegate，也不能再创建子对话
  const sub = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '继续' } as never, undefined, '', 'c1'),
    id: 'c1',
    parentTaskId: 'p1',
    rootTaskId: 'p1',
  } as Task
  const subLog: AgentCall[] = []
  const sh = host(sub, subLog, async (call) => {
    assert.equal(call.orch?.coordinator, false)
    assert.match(await call.orch!.conversations(), /不能分派子对话/)
    return { ok: true, text: '好的' }
  })
  sh.agents = [agent('m', '协调', { canDelegate: true })]
  await runEngineTurn(sh)
  assert.equal(subLog.length, 1)
})

/**
 * 对话等子任务时用户照样能聊：消息马上开一轮回复；整批交回时还在回复就插话打断，
 * 插不进去的等这一轮结束再交
 */
async function chatWhileHelpers(steerOk: boolean) {
  const id = steerOk ? 'h1' : 'h2'
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '查一下' } as never, undefined, '', id),
    id,
  } as Task
  const log: AgentCall[] = []
  let release!: () => void
  const helperGo = new Promise<void>((r) => (release = r))
  const steered: string[] = []
  let turn = 0
  const h = host(task, log, async (call) => {
    if (call.step) {
      await helperGo
      return { ok: true, text: '查到了' }
    }
    turn++
    if (turn === 1) {
      assert.equal(call.orch!.spawn([{ title: '调研', instructions: '查资料' }]).ids.length, 1)
      return { ok: true, text: '派出去了' }
    }
    if (turn === 2) {
      assert.match(call.prompt, /等待期间发来了消息[\s\S]*进度怎么样/)
      // 回复用户的时候子任务交回了：先插话打断这一轮
      release()
      for (let i = 0; i < 50 && !steered.length; i++) await new Promise((r) => setTimeout(r, 5))
      assert.equal(steered.length, 1)
      assert.match(steered[0], /先放下正在回复的这条用户消息[\s\S]*查到了/)
      return { ok: true, text: '还在查' }
    }
    assert.match(call.prompt, /子任务都结束了，结果如下[\s\S]*查到了/)
    return { ok: true, text: '整理好了' }
  })
  h.agents = [agent('m', '协调')]
  let asked = 0
  h.waitChat = (signal) => {
    if (asked++ === 0) {
      task.messages.push({ id: 'u2', role: 'user', agentId: '', step: '', text: '进度怎么样', tools: [], at: '' })
      return Promise.resolve('进度怎么样')
    }
    return new Promise((r) => signal.addEventListener('abort', () => r(null), { once: true }))
  }
  h.steer = async (stepId, text) => {
    assert.equal(stepId, '')
    steered.push(text)
    return steerOk
  }
  await runEngineTurn(h)
  assert.equal(task.status, 'done')
  assert.ok(task.messages.some((m) => m.role === 'user' && m.text === '进度怎么样' && !m.step))
  assert.equal(task.messages.filter((m) => m.panel === 'helpers').length, 1, '结果只交回一次')
  return log.filter((c) => !c.step).length
}

test('等子任务时发消息：马上回复，结果交回时插话打断', async () => {
  assert.equal(await chatWhileHelpers(true), 2, '结果插进了回复用户的那一轮，不再单独开一轮')
})

test('等子任务时发消息：插话交不进去，回复完再处理结果', async () => {
  assert.equal(await chatWhileHelpers(false), 3)
})

test('分派角色用在不能分派的地方：明说角色设定里的分派规则这次不适用', async () => {
  const mk = (id: string, extra: Partial<Parameters<typeof newTask>[0]> = {}) =>
    ({
      ...newTask(
        { projectId: 'p', mode: 'chat', agentId: 'm', prompt: '查一下', ...extra } as never,
        undefined,
        '',
        id,
      ),
      id,
    }) as Task
  const run = async (task: Task) => {
    const log: AgentCall[] = []
    const h = host(task, log, async () => ({ ok: true, text: '好了' }))
    h.agents = [agent('m', '统筹', { canDelegate: true })]
    await runEngineTurn(h)
    return log[0]
  }
  // 子对话里换成了「统筹」：不能再建子对话
  const sub = await run(mk('s1', { parentTaskId: 'top' }))
  assert.equal(sub.orch?.coordinator, false)
  assert.match(sub.prompt, /没有创建子对话/)
  assert.match(sub.prompt, /分派子对话的规则这次不适用/)
  // 独立聊天没有项目：create_conversation 一定失败，也不按分派对话提示
  const free = await run(mk('s2', { projectId: '' }))
  assert.equal(free.orch?.coordinator, false)
  assert.match(free.prompt, /分派子对话的规则这次不适用/)
  // 项目里的父对话：能分派，不加这句
  const top = await run(mk('s3'))
  assert.equal(top.orch?.coordinator, true)
  assert.doesNotMatch(top.prompt, /这次不适用/)
})

test('回复完停在等下一句时被停下：这一轮算正常结束，不记成被打断', async () => {
  const mk = (id: string) =>
    ({
      ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '查一下' } as never, undefined, '', id),
      id,
    }) as Task
  // CLI 已经报过这一轮完成（turnDoneAt），之后保活的进程被收掉
  const idle = mk('k1')
  await runEngineTurn(
    host(idle, [], async () => {
      idle.turnDoneAt = new Date(Date.now() + 5).toISOString()
      return { ok: false, stopped: true, error: '已停止' }
    }),
  )
  assert.equal(idle.turns.at(-1)?.status, 'done')
  // 回复到一半被停：照样是被打断
  const half = mk('k2')
  await runEngineTurn(host(half, [], async () => ({ ok: false, stopped: true, error: '已停止' })))
  assert.equal(half.turns.at(-1)?.status, 'stopped')
})

test('list_conversations：父对话能看到子对话在做什么、在等什么、多久没新输出', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '看下子对话' } as never, undefined, '', 'p4'),
    id: 'p4',
  } as Task
  const log: AgentCall[] = []
  const h = host(task, log, async (call) => {
    const text = await call.orch!.conversations()
    assert.match(text, /改后端/)
    assert.match(text, /等 1 个后台命令/)
    assert.match(text, /在做：跑测试/)
    assert.match(text, /最后活动/)
    return { ok: true, text: '好' }
  })
  h.agents = [agent('m', '协调', { canDelegate: true })]
  h.listConversations = async () => [
    {
      id: 'c1',
      title: '改后端',
      status: 'running',
      busy: true,
      summary: '在改接口',
      at: '2026-01-01T10:00:00Z',
      doing: '跑测试',
      waiting: '等 1 个后台命令',
      lastActivityAt: new Date().toISOString(),
    },
  ]

  await runEngineTurn(h)
  assert.equal(log.length, 1)
})
