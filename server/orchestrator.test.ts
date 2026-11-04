import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { convState, convStateText, newTask, taskFacts } from '../shared/task.ts'
import { activePlan, applyPlan } from '../shared/plan.ts'
import { runEngineTurn, stopPlan, type AgentCall, type EngineHost } from '../shared/engine.ts'

/**
 * 项目对话：父对话直接执行、分派子对话，或者用 start_workflow 开工作流子对话（ADR 0044）；
 * 用的是 Agent 自己配置的能力（canPlan / canDelegate），不再有常驻编排器。
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

/** 工作流子对话（ADR 0044）：父对话 start_workflow 开出来的，第一轮由面板按流程图跑 */
const flowKid = (id: string, extra: Partial<Task> = {}) =>
  ({
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'w', prompt: '做功能' } as never, undefined, '', id),
    id,
    parentTaskId: 'p0',
    rootTaskId: 'p0',
    flow: { workflowId: 'wf', workflowName: '执行计划', input: '做功能', kind: 'change', run: 0, handed: false },
    ...extra,
  }) as Task

test('工作流子对话：先按流程图跑完，再带着结果交给执行角色收尾', async () => {
  const task = flowKid('k1')
  const log: AgentCall[] = []
  const h = host(task, log, async (call) => {
    if (call.step) return { ok: true, text: `${call.step.title}好了` }
    if (/补一个测试/.test(call.prompt)) return { ok: true, text: '补好了' }
    // 执行角色只收尾：拿到的是流程图的结果，不是「从头做一遍」
    assert.match(call.prompt, /工作流「执行计划」跑完了/)
    assert.match(call.prompt, /验收好了/)
    assert.match(call.prompt, /评审.*完整测试和编译.*合回/)
    assert.doesNotMatch(call.prompt, /## 可用工作流/, '子对话不列可用工作流')
    assert.equal(call.orch?.planning, false)
    return { ok: true, text: '收尾好了' }
  })
  h.agents = [agent('w', '执行', { canPlan: true })]

  await runEngineTurn(h)
  assert.equal(task.status, 'done')
  assert.equal(task.flow?.handed, true)
  assert.equal(task.flow?.run, 1)
  assert.equal(task.runs.length, 1)
  assert.equal(task.runs[0].status, 'done')
  assert.equal(task.plans[0].steps[0].run, 1, '流程图是子对话计划里的一个主步骤')
  assert.deepEqual(
    log.filter((c) => !!c.step).map((c) => c.step!.id),
    ['a', 'b'],
  )
  assert.equal(log.filter((c) => !c.step).length, 1, '流程图跑完交给执行角色一轮')
  // 再来一条消息：流程图已经交出去了，按普通子对话由执行角色处理，不再跑节点
  h.prompt = '补一个测试'
  await runEngineTurn(h)
  assert.equal(log.filter((c) => !!c.step).length, 2)
})

test('工作流子对话被停下：同一次运行在继续时从没做完的节点接着跑，不重新起', async () => {
  const task = flowKid('k2')
  const log: AgentCall[] = []
  let stopB = true
  const h = host(task, log, async (call) => {
    if (call.step?.id === 'b' && stopB) {
      stopB = false
      return { ok: false, stopped: true, error: '' }
    }
    if (call.step) return { ok: true, text: `${call.step.title}好了` }
    return { ok: true, text: '收尾好了' }
  })
  h.agents = [agent('w', '执行')]

  await runEngineTurn(h)
  assert.equal(task.status, 'stopped')
  assert.equal(task.runs[0].status, 'stopped')
  assert.equal(task.flow?.handed, false)
  assert.equal(log.filter((c) => !c.step).length, 0, '没跑完不交给执行角色')

  h.resume = true
  h.prompt = '（面板：继续执行）'
  await runEngineTurn(h)
  assert.equal(task.status, 'done')
  assert.equal(task.runs.length, 1, '还是同一次运行')
  assert.equal(task.runSeq, 1)
  assert.deepEqual(
    log.filter((c) => !!c.step).map((c) => c.step!.id),
    ['a', 'b', 'b'],
    '「实现」做完了不重跑，「验收」接着做',
  )
  assert.equal(task.flow?.handed, true)
})

test('工作流子对话的节点失败：按失败交回父对话，父对话的意见交给失败的节点重跑，再接着往下走', async () => {
  const task = flowKid('k3')
  const log: AgentCall[] = []
  let failB = true
  const h = host(task, log, async (call) => {
    if (call.step?.id === 'b' && failB) {
      failB = false
      return { ok: false, error: '验收没过' }
    }
    if (call.step) return { ok: true, text: `${call.step.title}好了` }
    return { ok: true, text: '收尾好了' }
  })
  h.agents = [agent('w', '执行')]

  await runEngineTurn(h)
  assert.equal(task.status, 'failed')
  assert.equal(task.runs[0].status, 'failed')
  assert.ok(task.messages.some((m) => /工作流停在「验收」/.test(m.text)))

  h.prompt = '把空值也算上再验'
  await runEngineTurn(h)
  const rerun = log.filter((c) => c.step?.id === 'b').at(-1)!
  assert.match(rerun.prompt, /父对话：把空值也算上再验/, '意见交给重跑的节点')
  assert.equal(task.status, 'done')
  assert.equal(task.flow?.handed, true)
  assert.deepEqual(
    log.filter((c) => !!c.step).map((c) => c.step!.id),
    ['a', 'b', 'b'],
  )
})

test('终止工作流子对话：没跑的节点不再跑，按失败交回，改了哪些文件写进结果；之后的消息交给执行角色', async () => {
  const task = flowKid('k4')
  const log: AgentCall[] = []
  const h = host(task, log, async (call) => {
    if (call.step) {
      // 节点调用带着这次运行的终止信号：终止时正在跑的节点跟着结束
      assert.ok(call.signal, '工作流节点要带上运行的终止信号')
      assert.equal(stopPlan('k4', '方向错了'), true)
      assert.equal(call.signal!.aborted, true)
      return { ok: false, stopped: true, error: '' }
    }
    return { ok: true, text: '撤回了 src/a.ts' }
  })
  h.agents = [agent('w', '执行')]
  h.reviewDiff = async (since) => ({ snapshot: 's1', stat: since ? ' src/a.ts | 3 +++' : '', diff: '' })

  await runEngineTurn(h)
  assert.equal(task.status, 'failed')
  assert.equal(task.flow?.cancelled, true)
  assert.equal(task.runs[0].status, 'stopped')
  assert.ok(task.messages.some((m) => /工作流被终止：方向错了[\s\S]*src\/a\.ts \| 3/.test(m.text)))
  assert.deepEqual(
    log.filter((c) => !!c.step).map((c) => c.step!.id),
    ['a'],
    '终止后「验收」不再开始',
  )
  assert.equal(stopPlan('k4', '再停一次'), false, '运行结束后没有可停的')
  // 父对话再交消息：交给执行角色处理，不再跑流程图
  h.prompt = '把 src/a.ts 撤回'
  await runEngineTurn(h)
  assert.equal(log.filter((c) => !!c.step).length, 1)
  assert.equal(log.filter((c) => !c.step).length, 1)
})

test('终止工作流：拍快照的那段时间里也停得下来，一个节点都不跑', async () => {
  const task = flowKid('k5')
  const log: AgentCall[] = []
  const h = host(task, log, async () => ({ ok: true, text: '好的' }))
  h.agents = [agent('w', '执行')]
  // 拍快照的时候用户点了终止：这时开关必须已经登记好
  h.reviewDiff = async (since) => {
    if (!since) assert.equal(stopPlan('k5', '点早了'), true, '快照期间点终止要停得下来')
    return { snapshot: 's1', stat: ' old.ts | 1 +', diff: '' }
  }

  await runEngineTurn(h)
  assert.equal(task.runs[0].status, 'stopped')
  assert.equal(task.flow?.cancelled, true)
  assert.deepEqual(log, [], '一个节点都不跑，也不交给执行角色')
  assert.ok(!task.messages.some((m) => /old\.ts/.test(m.text)), '运行前就有的改动不算它的')
})

test('只有父对话能启动工作流：父对话列可用工作流和判定规则，子对话、没开 canPlan 的都没有', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '做功能' } as never, undefined, '', 'p9'),
    id: 'p9',
  } as Task
  const made: { title: string; flow?: Task['flow'] }[] = []
  const h = host(task, [], async (call) => {
    assert.equal(call.orch?.planning, true)
    assert.match(call.prompt, /## 可用工作流\n- id: wf｜执行计划（默认）/)
    assert.match(call.prompt, /拿不准就交给子对话，不起工作流/)
    assert.equal(call.orch!.pickWorkflow('没有这个').ok, false)
    const got = call.orch!.pickWorkflow('执行计划')
    assert.ok(got.ok)
    const r = await call.orch!.createConversation('做功能', '做功能', undefined, undefined, {
      flow: { ...got.flow, input: '做功能' },
    })
    assert.equal(r.ok, true)
    return { ok: true, text: '已启动工作流' }
  })
  // 开着「先建模块文档」、宿主能查模块文档：工作流子对话也不能被这道门拦住（start_workflow 没有 modules 参数，2026-11-03 真实 API 实测）
  h.agents = [
    agent('m', '协调器', {
      canDelegate: true,
      canPlan: true,
      params: [
        {
          key: 'docsFirst',
          label: '先建模块文档',
          type: 'bool',
          default: true,
          options: [],
          description: '',
          ask: false,
        },
      ],
    }),
  ]
  h.moduleDocs = async (modules) => ({ root: '/p/docs', found: {}, missing: modules })
  h.listConversations = async () => []
  h.createConversation = async ({ title, flow }) => {
    made.push({ title, flow })
    return { ok: true, id: 'k9', title, info: '已新建' }
  }
  await runEngineTurn(h)
  assert.equal(made[0].flow?.workflowId, 'wf')
  assert.equal(made[0].flow?.input, '做功能')
  assert.equal(
    task.plans.at(-1)?.steps.some((s) => s.waits.some((w) => w.ref === 'k9')),
    true,
    '父计划等它',
  )

  // 没开 canPlan 的父对话、子对话（即使角色开了 canPlan）：不列目录，pickWorkflow 拒绝
  for (const [t0, a] of [
    [{ ...task, id: 'p10', plans: [], messages: [] } as Task, agent('m', '协调器', { canDelegate: true })],
    [
      { ...task, id: 'c10', parentTaskId: 'p9', plans: [], messages: [] } as Task,
      agent('m', '执行', { canPlan: true }),
    ],
  ] as const) {
    const h2 = host(t0, [], async (call) => {
      assert.equal(call.orch?.planning, false)
      assert.doesNotMatch(call.prompt, /## 可用工作流/)
      assert.match(
        call.orch!.pickWorkflow('').ok ? '' : (call.orch!.pickWorkflow('') as { info: string }).info,
        /只有项目里的父对话能启动工作流/,
      )
      return { ok: true, text: '直接做' }
    })
    h2.agents = [a]
    await runEngineTurn(h2)
  }
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

test('协调 Agent：同一段话只在这条用户消息里去重，用户新发一条后交给别的子对话照常放行（重启后按记录同样判断）', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '先把 A 做完' } as never, undefined, '', 'u1'),
    id: 'p1',
  } as Task
  const got: { id: string; ok: boolean }[] = []
  let to = 'c1'
  const h = host(task, [], async (call) => {
    const r = await call.orch!.sendToConversation(to, '继续')
    got.push({ id: to, ok: r.ok })
    // 照 CLI 的样子把这次调用记进对话：重启后内存里的记录没了，只能按对话里的记录查
    task.messages.push({
      id: `a${got.length}`,
      role: 'agent',
      agentId: 'm',
      step: '',
      text: '',
      tools: [
        {
          kind: 'other',
          name: 'MCP',
          label: 'panel · send_to_conversation',
          detail: '',
          input: JSON.stringify({ id: to, message: '继续' }),
          ...(!r.ok && { failed: true }),
        },
      ],
      at: '',
    } as never)
    return { ok: true, text: '好' }
  })
  h.agents = [agent('m', '协调', { canDelegate: true })]
  h.listConversations = async () => []
  h.sendToConversation = async (id) => ({ ok: true, info: `已交给「${id}」` })

  await runEngineTurn(h)
  // 子对话交回拉起的一轮：还是同一条用户消息，「继续」再交给 c2 被拒
  task.messages.push({
    id: 's1',
    role: 'system',
    agentId: '',
    step: '',
    text: '子对话 A 做完了',
    tools: [],
    at: '',
    panel: 'child',
  } as never)
  to = 'c2'
  await runEngineTurn(h)
  // 用户新发一条：同一句短话交给 c2 放行
  task.messages.push({ id: 'u2', role: 'user', agentId: '', step: '', text: 'B 也继续', tools: [], at: '' } as never)
  await runEngineTurn(h)
  // 重启：换一个对象（内存里的 handedOff 没了），这条消息里再交给 c3 仍按对话记录拒绝
  const again = structuredClone(task)
  const h2 = { ...h, task: again }
  to = 'c3'
  const r = await (async () => {
    let out: { ok: boolean; info: string } | undefined
    h2.runAgent = async (call) => {
      out = await call.orch!.sendToConversation('c3', '继续')
      return { ok: true, text: '好' }
    }
    await runEngineTurn(h2)
    return out!
  })()
  assert.deepEqual(got, [
    { id: 'c1', ok: true },
    { id: 'c2', ok: false },
    { id: 'c2', ok: true },
  ])
  assert.equal(r.ok, false)
  assert.match(r.info, /已经交给了子对话 c2/)
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

test('协调 Agent：子对话失败后另建「（重试）」会被拒绝，要交回原来那个子对话（用户 2026-10-25）', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '重试一下' } as never, undefined, '', 'p1'),
    id: 'p1',
  } as Task
  const log: AgentCall[] = []
  const made: string[] = []
  const infos: string[] = []
  const h = host(task, log, async (call) => {
    assert.match(call.prompt, /重试：用 send_to_conversation 交回原来那个子对话/)
    const r = await call.orch!.createConversation('修登录（重试）', '再做一遍')
    infos.push(r.info)
    assert.equal(r.ok, false)
    // 换了一件事照常新建
    assert.equal((await call.orch!.createConversation('改按钮颜色', '改成蓝色')).ok, true)
    return { ok: true, text: '已交回原来的子对话。' }
  })
  h.agents = [agent('m', '协调', { canDelegate: true })]
  h.listConversations = async () => [
    { id: 'c1', title: '修登录', status: convStateText('failed'), summary: '', at: '' },
  ]
  h.createConversation = async ({ title }) => {
    made.push(title)
    return { ok: true, id: 'c2', title, info: '已新建' }
  }
  await runEngineTurn(h)
  assert.deepEqual(made, ['改按钮颜色'])
  assert.match(infos[0], /send_to_conversation 交回给它（id c1）/)
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
  assert.match(sub.prompt, /不能创建子对话/)
  assert.match(sub.prompt, /分派子对话的规则这次不适用/)
  // Chat 模式（没有项目）：不按分派对话提示，提示词另起一套（ADR 0038），根本不提子对话的工具
  const free = await run(mk('s2', { projectId: '' }))
  assert.equal(free.orch?.coordinator, false)
  assert.match(free.prompt, /## Chat 模式/)
  assert.doesNotMatch(free.prompt, /create_conversation|## 执行方式/)
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
    // 每轮的「现有子对话」段不带逐分钟变的时间（会让整段每轮重发）：要看多久没输出用上面的 list_conversations
    const section = call.prompt.split('## 现有子对话')[1]?.split('\n## ')[0] ?? ''
    assert.match(section, /c2｜改前端/)
    assert.doesNotMatch(section, /最后活动|分钟前|没有新输出/)
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
    {
      id: 'c2',
      title: '改前端',
      status: 'running',
      state: 'running',
      busy: true,
      summary: '在改页面',
      at: '2026-01-01T10:00:00Z',
      lastActivityAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    },
  ]

  await runEngineTurn(h)
  assert.equal(log.length, 1)
})

/**
 * 回归（用户 2026-10-25 报）：计划已经结束（finish_plan）之后又派子对话，
 * 子对话挂不上任何步骤，计划面板停在上次「已完成」——用户看不到这些子对话属于哪一步。
 * 现在派子对话一定要挂上一步：计划结束了就重开它、补一步，标题用子对话的标题。
 */
test('协调 Agent：计划已结束后派子对话，自动重开计划并补一步（不再是挂不上）', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '继续派活' } as never, undefined, '', 'p1'),
    id: 'p1',
  } as Task
  const log: AgentCall[] = []
  const h = host(task, log, async (call) => {
    // 先列一份计划再提前结束它：模拟上一轮的「计划已完成」
    assert.equal(
      (
        await call.orch!.setPlan({
          steps: [{ title: '改界面', status: 'done' }, { title: '收尾的活' }],
        })
      ).ok,
      true,
    )
    assert.equal((await call.orch!.finishPlan('改好了界面，收尾的活交给子对话')).ok, true)
    assert.equal(activePlanOf(task), undefined, '计划确实结束了')
    // 总结记在这个对话自己的计划上（ADR 0041：各写各的计划）
    assert.equal(task.plans.at(-1)!.summary, '改好了界面，收尾的活交给子对话')
    const r = await call.orch!.createConversation('设计页 AI 对话复用 Chat 样式', '把设计页的对话换成 Chat 样式')
    assert.equal(r.ok, true)
    assert.match(r.info, /等待中/, '子对话挂到了步骤上')
    return { ok: true, text: '已交给子对话。' }
  })
  h.agents = [agent('m', '协调', { canDelegate: true })]
  h.listConversations = async () => []
  h.createConversation = async ({ title }) => ({ ok: true, id: 'c1', title, info: '已新建' })

  await runEngineTurn(h)
  const plan = task.plans.at(-1)!
  assert.equal(plan.doneAt, '', '计划被重新打开')
  const step = plan.steps.find((s) => s.auto)
  assert.ok(step, '自动补了一步')
  assert.equal(step!.title, '子对话：设计页 AI 对话复用 Chat 样式', '用子对话的标题')
  assert.equal(step!.status, 'waiting')
  assert.equal(step!.waits[0]?.ref, 'c1')
})

/** 真实接口测试发现：最后一步标完成时计划自动收起，模型没带 summary，计划上就一直没有总结 */
test('计划自动收起没带总结：set_plan 提醒补，finish_plan 只把总结补到刚收起的那份上', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '写两个文件' } as never, undefined, '', 'p2'),
    id: 'p2',
  } as Task
  const h = host(task, [], async (call) => {
    await call.orch!.setPlan({ steps: [{ title: '写 a' }, { title: '写 b' }] })
    const r = await call.orch!.setPlan({
      steps: [
        { title: '写 a', status: 'done' },
        { title: '写 b', status: 'done' },
      ],
    })
    assert.equal(activePlanOf(task), undefined, '全部完成，计划收起')
    assert.match(r.info, /还没写总结：用 finish_plan/)
    const f = await call.orch!.finishPlan('a、b 都写好了')
    assert.equal(f.ok, true)
    assert.equal(task.plans.at(-1)!.summary, 'a、b 都写好了')
    return { ok: true, text: '写好了。' }
  })
  h.agents = [agent('m', '协调')]
  await runEngineTurn(h)
})

/** 拿当前进行中的计划（测试里只关心有没有、内容是什么） */
const activePlanOf = (task: Task) => {
  const last = task.plans.at(-1)
  return last && !last.doneAt ? last : undefined
}

/**
 * ADR 0020：后台命令没点名步骤时自动挂到当前进行中的那一步。
 * 以前不带 step 的长命令在计划里完全看不见，计划就停在上一步（用户报的「做到第 4 步显示第 1 步」）。
 */
test('后台命令没点名步骤：自动挂到当前进行中的那一步，计划跟着变成等待中', async () => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'm', prompt: '修角标' } as never, undefined, '', 't-plan-bg'),
    id: 't-plan-bg',
  } as Task
  applyPlan(task, {
    steps: [{ title: '定位', status: 'done' }, { title: '跑端到端测试', status: 'running' }, { title: '收尾' }],
  })
  const seen: { step?: string }[] = []
  const log: AgentCall[] = []
  let turn = 0
  const h: EngineHost = {
    ...host(task, log, async (call) => {
      if (turn++ === 0) {
        const r = await call.orch!.runBackground({
          command: 'npm run test:e2e',
          name: '端到端测试',
          cwd: '.',
          exclusive: false,
        })
        assert.equal(r.ok, true)
        return { ok: true, text: '已放到后台' }
      }
      return { ok: true, text: '等结果' }
    }),
    runBackground: async (input) => {
      seen.push({ step: input.step })
      return { ok: true, id: 'job-1', info: '已放到后台（编号 job-1）。' }
    },
  }
  h.agents = [agent('m', '协调')]

  await runEngineTurn(h)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].step, '2', '挂到进行中的那一步，而不是不带归属')
  const plan = activePlan(task)!
  assert.equal(plan.steps[1].status, 'waiting', '跑长命令的那一步是等待中，不是进行中')
  assert.equal(plan.steps[1].waits[0]?.ref, 'job-1')
  assert.equal(plan.steps[1].waits[0]?.label, '端到端测试')
})

/** ADR 0020：每轮提示里要正面写出当前进度、滞后提醒，以及「新输入先判计划」「增量还是重开」两条硬约束 */
test('每轮提示：写出当前第几步、计划滞后提醒和新输入先判计划，规则里钉住增量/重开', async () => {
  const sixAgo = new Date(Date.now() - 6 * 60_000).toISOString()
  const task = {
    ...newTask(
      { projectId: 'p', mode: 'chat', agentId: 'm', prompt: '修角标' } as never,
      undefined,
      '',
      't-plan-prompt',
    ),
    id: 't-plan-prompt',
  } as Task
  applyPlan(
    task,
    { steps: [{ title: '定位', status: 'done' }, { title: '接线', status: 'running' }, { title: '跑测试' }] },
    sixAgo,
  )
  const plan = activePlan(task)!
  // 上一次改计划在 7 分钟前，6 分钟前进来过新要求：之后计划没动过
  plan.updatedAt = new Date(Date.now() - 7 * 60_000).toISOString()
  plan.lastInputAt = sixAgo

  const log: AgentCall[] = []
  let turn = 0
  const h = host(task, log, async (call) => {
    if (turn++ === 0) {
      // 每轮都要看到自己现在在第几步
      assert.match(call.prompt, /现在：第 2 步「接线」进行中（已 6 分钟）/)
      assert.match(call.prompt, /下一步是「跑测试」/)
      // running 步骤 6 分钟没变化：提醒先收口
      assert.match(call.prompt, /⚠ 计划还停在「接线」/)
      // 上一次输入之后计划没动过：要求先判计划
      assert.match(call.prompt, /进来了新要求/)
      // 两条硬约束的原句（改措辞要连着这里一起改）
      assert.match(call.prompt, /新输入先判计划/)
      assert.match(call.prompt, /增量还是重开/)
      assert.match(call.prompt, /一份计划里同时只能有一个进行中/)
      assert.match(call.prompt, /什么算完成一步/)
    }
    return { ok: true, text: '好的' }
  })
  h.agents = [agent('m', '协调')]

  await runEngineTurn(h)
  assert.equal(log.length, 1)
})

test('父对话派来的 Bug（ADR 0045）：子对话有 submit_diagnosis，交了报告等用户确认时算执行中；普通子对话、父对话都没有', async () => {
  const kid = (bug: boolean) =>
    ({
      ...newTask({ projectId: 'p', mode: 'chat', agentId: 'w', prompt: '修登录' } as never, undefined, '', 'b1'),
      id: 'b1',
      parentTaskId: 'p0',
      rootTaskId: 'p0',
      ...(bug && { bug: true }),
    }) as Task
  const bugKid = kid(true)
  const h = host(bugKid, [], async (call) => {
    assert.ok(call.orch?.diagnose, 'Bug 子对话有交诊断报告的工具')
    assert.ok(call.orch?.bugCase, '也有随查随记的档案工具（ADR 0046）')
    const r = call.orch!.diagnose!({
      level: 'quick',
      attribution: { category: 'recent', change: 'a1b2', how: 'blame' },
      symptom: '超时后一直转圈',
      repro: '',
      location: 'login.ts:40',
      evidence: '日志 ← login.ts:44',
      rootCause: '单位不对',
      confirmed: true,
      excluded: '',
      fix: '换成次数上限',
      files: ['login.ts'],
      risk: '',
      verify: 'login.test.ts 改前失败改后通过',
      answers: [],
    })
    assert.equal(r.ok, true)
    return { ok: true, text: '已交诊断报告，等确认' }
  })
  h.agents = [agent('w', '执行')]
  await runEngineTurn(h)
  assert.equal(bugKid.requests.length, 0, '不挂成等你处理的请求')
  assert.equal(bugKid.diagnoses?.[0].status, 'pending')
  assert.equal(
    convState(taskFacts(bugKid)),
    'running',
    '等确认期间子对话算执行中，父对话那边照样转圈（用户 2026-11-03 定的）',
  )

  for (const t0 of [kid(false), { ...kid(false), id: 'p1', parentTaskId: '' } as Task]) {
    const h2 = host(t0, [], async (call) => {
      assert.equal(call.orch?.diagnose, undefined)
      assert.equal(call.orch?.bugCase, undefined)
      return { ok: true, text: '直接修' }
    })
    h2.agents = [agent('w', '执行')]
    await runEngineTurn(h2)
  }
})
