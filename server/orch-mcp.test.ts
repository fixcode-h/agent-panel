import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost, type HelperSpec, type Orchestra } from '../shared/engine.ts'
import { activePlan, applyPlan } from '../shared/plan.ts'
import { callOrchTool, orchHint, orchTools } from './orch-mcp.ts'
import { askMcpApi, openAskBridge } from './ask-mcp.ts'

const agent = (id: string, name: string): Agent => ({
  ...AgentInput.parse({ name }),
  id,
  createdAt: '',
  updatedAt: '',
})
const agents = [agent('m', '主管'), agent('w', '开发'), agent('q', '测试')]

const workflow = (): Workflow =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '并发',
    mainAgentId: 'm',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'a', title: '实现', agentId: 'w', instructions: '写代码。' },
          { id: 'b', title: '测试', agentId: 'q', instructions: '跑测试。' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'start', to: 'b' },
          { id: 'e3', from: 'a', to: 'end' },
          { id: 'e4', from: 'b', to: 'end' },
        ],
      },
    ],
  })

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n')

/** 模拟 CLI：实现节点派两个子 Agent、写共享状态、给测试节点传话 */
function host(task: Task, log: AgentCall[]): EngineHost {
  const w = workflow()
  let n = 0
  return {
    task,
    agents,
    workflows: [w],
    workflow: w,
    prompt: '做功能',
    changed: () => {},
    newId: () => `id${++n}`,
    runAgent: async (call) => {
      log.push(call)
      const o = call.orch!
      if (call.step?.id === 'a') {
        const r = await callOrchTool(o, 'spawn_agents', {
          tasks: [
            { title: '接口', instructions: '写接口' },
            { title: '页面', instructions: '写页面', agent: '测试', tier: 'low' },
          ],
        })
        assert.match(text(r), /a\/sub\/h1、a\/sub\/h2/)
        assert.match(text(await callOrchTool(o, 'write_state', { key: 'interface', value: '接口改名了' })), /v1/)
        assert.match(text(await callOrchTool(o, 'read_state', {})), /interface（v1/)
        assert.match(text(await callOrchTool(o, 'send_message', { to: '测试', text: '接口改名了' })), /测试/)
        const got = text(await callOrchTool(o, 'wait_agents', { seconds: 5 }))
        assert.match(got, /做完 2 个/)
        assert.match(got, /子 Agent「接口」做完了/)
        assert.match(text(await callOrchTool(o, 'get_status', {})), /- a\/sub\/h2｜子 Agent · 页面（测试）：完成/)
        return { ok: true, text: '实现好了' }
      }
      if (call.step?.slot === 'sub') {
        // 子任务不能再派子任务、不能启动工作流，工具列表里也没有这些
        if (call.step.id === 'a/sub/h1') {
          assert.equal(o.helper, true)
          assert.match(
            text(await callOrchTool(o, 'spawn_agents', { tasks: [{ title: '更细', instructions: '拆得更细' }] })),
            /不能再派子任务/,
          )
          assert.match(text(await callOrchTool(o, 'start_plan', { input: '跑一遍' })), /不能启动工作流/)
          const names = orchTools(o).map((x) => x.name)
          assert.ok(!names.includes('spawn_agents') && !names.includes('start_plan'), names.join(','))
        }
        return { ok: true, text: `子 Agent「${call.step.title}」做完了` }
      }
      // 测试节点晚一点开始读消息：实现节点传的话要在
      await new Promise((r) => setTimeout(r, 50))
      return { ok: true, text: `测试好了：${text(await callOrchTool(o, 'read_messages', {}))}` }
    },
  }
}

/**
 * spawn_agents 的 step：这一批子任务全部结束、结果交回时，把计划里那一步收口。
 * 以前没有这个参数，派「版本控制」跑收尾那种步骤只能靠 linkKids 按标题猜，猜不中就永远挂在计划里，
 * 用户看到的就是「做完了还是进行中 / 一直等待中」。
 *
 * takeAway：子任务先做完、模型用 wait_agents 把结果取走再收轮（只能手动等的模式里就是这样）。
 * 这时收轮时已经没有「没取回的结果」，收口不能只看这一批（以前只看 late，这一步就永远停在等待中）。
 */
async function spawnWithStep(helperOk: boolean, takeAway = false, mixed = false) {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', prompt: '收尾' } as never, undefined, '', 't5'),
    id: 't5',
  } as Task
  applyPlan(task, { steps: [{ title: '派版本控制收尾', status: 'running' }, { title: '汇总' }] })
  const plan = activePlan(task)!
  let orch: AgentCall['orch']
  let turn = 0
  // 子任务跑完的信号：等它完成后才调 wait_agents，才能把结果真正取走
  let finished = () => {}
  const done = new Promise<void>((r) => (finished = r))
  const h: EngineHost = {
    task,
    agents,
    workflows: [],
    prompt: '收尾',
    changed: () => {},
    newId: () => `id${task.messages.length}`,
    runAgent: async (call) => {
      if (call.step?.slot === 'sub') {
        finished()
        // mixed：同一批里一只成功一只失败，最后必须退成进行中（不能因为有一只成功就标完成）
        const ok = mixed ? call.step.title === '甲' : helperOk
        return ok ? { ok: true, text: '合回去了' } : { ok: false, error: '推送被拦' }
      }
      orch = call.orch
      if (turn++ === 0) {
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          step: plan.steps[0].id,
          tasks: [{ title: '版本控制', instructions: '合并并推送' }],
        })
        assert.match(text(r), /已标成等待中/, '点名了步骤就在回复里说清挂上了')
        // 先等它做完、把结果取走，再派出第二只（不然 takeAway 场景没构造出来）。
        // takeAway 时不再派第二批：第二批没被取走，收轮时 late 非空，就分不出「收口只看这一批」的旧行为了
        if (takeAway) {
          await done
          assert.match(text(await callOrchTool(call.orch!, 'wait_agents', { seconds: 1 })), /版本控制（完成）/)
          return { ok: true, text: '好了' }
        }
        // 多个子任务时只重复一行说明，不刷 N 行一样的话
        const r2 = await callOrchTool(call.orch!, 'spawn_agents', {
          step: plan.steps[1].id,
          tasks: [
            { title: '甲', instructions: '查甲' },
            { title: '乙', instructions: '查乙' },
          ],
        })
        assert.equal((text(r2).match(/已标成等待中/g) ?? []).length, 1, '两个子任务共用一句说明')
      }
      return { ok: true, text: '好了' }
    },
  }
  await runEngineTurn(h)
  return { task, plan, orch: orch! }
}

test('spawn_agents 带 step：子任务全部成功后，计划里那一步标完成', async () => {
  const { plan } = await spawnWithStep(true)
  assert.equal(plan.steps[0].status, 'done', '子任务做完了，这一步跟着完成')
  assert.equal(plan.steps[0].waits[0]?.kind, 'helper')
  assert.equal(plan.steps[1].status, 'done', '第二个步骤的两个子任务也做完了，同样收口')
})

test('spawn_agents 带 step：子任务失败或没跑起来，这一步标成失败并写清原因（ADR 0020）', async () => {
  const { plan } = await spawnWithStep(false)
  assert.notEqual(plan.steps[0].status, 'done', '子任务没成功，不能盲目标完成')
  // failed 不是终态：等对话决定重做（标 running）还是明确跳过（标 skipped），不会一直显示「进行中」
  assert.equal(plan.steps[0].status, 'failed')
  assert.match(plan.steps[0].note, /没成功/)
})

test('spawn_agents 带 step：同一批一成败，这一步标成失败而不是完成', async () => {
  // 这组「甲成功、乙失败」挂在第 2 步上：只要还有一只没成功，整步就不能算完成
  const { plan } = await spawnWithStep(false, false, true)
  assert.equal(plan.steps[1].status, 'failed', '一只成功一只失败：整步失败，需要处理')
  assert.match(plan.steps[1].note, /没成功/)
})

test('spawn_agents 带 step：结果已经被 wait_agents 取走，这一步照样收口', async () => {
  // 收轮时已经没有「没取回的结果」了：收口只看这一批（late）就会漏掉，步骤永远停在等待中。
  // 这里只派一只并把它取走，第二批不派——否则 late 非空，旧行为也会跟着走到收口
  const { plan } = await spawnWithStep(true, true)
  assert.equal(plan.steps[0].status, 'done', '结果被取走过，这一步也要跟着完成')
  assert.equal(plan.steps[1].status, 'pending', '没有子任务的步骤不动')
})

test('spawn_agents 的 step 只在有执行计划的对话里出现', () => {
  const base = { self: 'n1', common: [], hasMain: false } as unknown as Parameters<typeof orchTools>[0]
  const props = (o: Parameters<typeof orchTools>[0]) =>
    (orchTools(o).find((x) => x.name === 'spawn_agents')!.inputSchema as { properties: Record<string, unknown> })
      .properties
  assert.equal(props({ ...base, plans: true, helper: false }).step !== undefined, true)
  assert.equal(props({ ...base, plans: false, helper: false }).step, undefined)
})

test('spawn_agents / create_conversation 的字段描述带上派单纪律', () => {
  // 描述就是模型看到的用法说明：只写「不写跟你一样」「不写取 instructions 第一行」会导向低档派单和同标题
  const o = { self: 'a', hasMain: false, common: [], coordinator: true, plans: false } as unknown as Parameters<
    typeof orchTools
  >[0]
  const tools = orchTools(o)
  const schemaOf = (name: string) =>
    tools.find((x) => x.name === name)!.inputSchema as unknown as {
      properties: {
        message?: { description: string }
        tasks?: { items: { properties: Record<string, { description: string }> } }
      }
    }
  const taskProps = schemaOf('spawn_agents').properties.tasks!.items.properties
  assert.match(taskProps.tier.description, /纯执行动作写 low/, '删文件、提交这类动作不该按父对话的档位跑')
  assert.match(taskProps.title.description, /10–20 字/)
  assert.match(taskProps.title.description, /同一批不能有两个相同的标题/)
  assert.match(taskProps.instructions.description, /不要把同一段话发给多个任务/)
  assert.match(
    taskProps.instructions.description,
    /派「文档」时给出要记什么和依据在哪/,
    '文档角色也常由 spawn_agents 派',
  )
  const message = schemaOf('create_conversation').properties.message!
  assert.match(message.description, /派「文档」时给出要记什么和依据在哪/)
  assert.match(message.description, /涉及的模块或目录/)
})

test('编排工具：派子 Agent 并行、读写共享状态、传话，节点不再经过主 Agent', async () => {
  const w = workflow()
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't1'),
    id: 't1',
  } as Task
  const log: AgentCall[] = []
  await runEngineTurn(host(task, log))
  assert.equal(task.status, 'done', JSON.stringify(task.messages.map((m) => m.text)))
  const by = (id: string) => task.steps.find((s) => s.id === id)!
  assert.equal(
    task.steps.some((s) => s.kind === 'main'),
    false,
    '不再有常驻编排器',
  )
  assert.equal(by('a/sub/h1').parentId, 'a')
  assert.equal(
    task.steps.some((s) => s.id.startsWith('a/sub/h1/sub/')),
    false,
    '子任务里不能再派子任务',
  )
  assert.equal(by('a/sub/h2').agentId, 'q', '按名字交给指定的 Agent')
  assert.equal(log.find((c) => c.step?.id === 'a/sub/h2')?.tier, 'low')
  assert.match(by('b').output, /来自「实现」的消息：接口改名了/, '传话进了对方的收件箱')
  assert.equal(log.filter((c) => c.dispatching).length, 0, '没有主 Agent 调度轮')
  // 工作流节点仍然拿得到共享状态：这个能力不能因为对话模式不注册就被一起砍掉
  // （工具表另有一处 deepEqual 断言含 read_state / write_state；节点内 read_state 能读出 a 写的值）
  const withState = task.runs[0]?.state.interface
  assert.ok(withState && withState.version >= 1, '节点 a 写的共享状态留在这次运行里')
  assert.ok(task.messages.some((m) => m.step === 'a' && /派出 2 个子角色/.test(m.text)))
})

test('编排工具挂在面板的 MCP 上：列出工具、调用、结束后失效', async () => {
  const w = workflow()
  const task = { ...newTask({ projectId: 'p', mode: 'workflow', prompt: 'x' } as never, w, '', 't2'), id: 't2' } as Task
  const log: AgentCall[] = []
  let orch: AgentCall['orch']
  const h = host(task, log)
  h.runAgent = async (call) => {
    if (call.step?.id === 'a') orch = call.orch
    return { ok: true, text: 'ok' }
  }
  await runEngineTurn(h)
  const s = openAskBridge({ orch: orch! })
  const app = askMcpApi()
  const path = new URL(s.url).pathname.replace('/api/mcp', '')
  const post = (body: unknown) =>
    app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const list = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
  const names = list.result.tools.map((x: { name: string }) => x.name)
  // 节点里的调用没有起停运行、分派子对话的工具
  assert.deepEqual(names, [
    'get_status',
    'read_state',
    'write_state',
    'spawn_agents',
    'stop_subtask',
    'wait_agents',
    'send_message',
    'read_messages',
  ])
  const st = await (
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } })
  ).json()
  assert.match(st.result.content[0].text, /- a｜实现（开发）【你】：完成/)
  s.close()
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 404)
})

test('编排工具：通用 Agent 列在 spawn_agents 和用法说明里', async () => {
  const o = {
    self: 'a',
    hasMain: false,
    common: [{ name: '代码侦察', description: '只读定位代码' }],
  } as unknown as Orchestra
  const s = openAskBridge({ orch: o })
  const path = new URL(s.url).pathname.replace('/api/mcp', '')
  const res = await askMcpApi().request(path, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    headers: { 'content-type': 'application/json' },
  })
  const tools = (await res.json()).result.tools
  const spawn = tools.find((x: { name: string }) => x.name === 'spawn_agents')
  assert.match(spawn.inputSchema.properties.tasks.items.properties.agent.description, /「代码侦察」（只读定位代码）/)
  assert.match(orchHint(o), /可以派的通用 Agent：「代码侦察」/)
  assert.doesNotMatch(orchHint({ ...o, common: [] }), /通用 Agent/)
  s.close()
})

test('对话里派的子 Agent 挂在 @chat 下，get_status 也要列出来', async () => {
  // 对话没有节点：@chat 只是传给 runAgent 的一个构造对象，不在 task.steps 里，
  // 子 Agent 的 parentId 是 @chat，从空 parentId 往下遍历会一个都找不到
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', prompt: '做功能' } as never, undefined, '', 't3'),
    id: 't3',
    // 对话里跑过 start_plan：task.runs 里留着上一次运行的记录和它写下的共享状态
    runSeq: 1,
    runs: [
      {
        id: 1,
        workflowId: 'wf',
        // 进程被强杀 / 面板重启时 task.runs 不会收尾，status 一直停在 running
        status: 'running',
        state: { interface: { value: '上一轮工作流留下的接口约定', version: 2, by: 'a', at: '' } },
        messages: [],
      },
    ],
  } as unknown as Task
  let orch: AgentCall['orch']
  const prompts: string[] = []
  const h: EngineHost = {
    task,
    agents,
    workflows: [],
    prompt: '做功能',
    changed: () => {},
    newId: () => `id${task.messages.length}`,
    runAgent: async (call) => {
      if (call.step?.slot === 'sub') {
        // 对话里的子任务用不上共享状态：即使对话跑过 start_plan、task.runs 还留着上一次运行，
        // 也不能把这两个工具注册回来，更不能把上一次运行的 state 交给它
        assert.equal(call.orch!.sharedState, false)
        assert.ok(!orchTools(call.orch!).some((x) => x.name === 'read_state' || x.name === 'write_state'))
        assert.doesNotMatch(orchHint(call.orch!), /read_state/)
        return { ok: true, text: '页面查好了' }
      }
      prompts.push(call.prompt)
      orch = call.orch
      if (prompts.length === 1) {
        const r = await callOrchTool(call.orch!, 'spawn_agents', { tasks: [{ title: '页面', instructions: '写页面' }] })
        assert.match(text(r), /sub\/h1/)
        assert.match(text(r), /结果会自动交回/)
      }
      return { ok: true, text: '好了' }
    },
  }
  await runEngineTurn(h)
  assert.match(text(await callOrchTool(orch!, 'get_status', {})), /@chat\/sub\/h1/)
  // 对话里结果自动交回：不给等待工具、说明里也不提，免得模型每隔几十秒轮询一次
  assert.equal(orch!.autoReturn, true)
  assert.ok(!orchTools(orch!).some((x) => x.name === 'wait_agents'))
  assert.doesNotMatch(orchHint(orch!), /wait_agents/)
  // 共享状态只存在于工作流运行的 task.runs 里，对话模式没有：不注册这两个工具，说明里也不提，
  // 否则对话里的子任务一调就得到「这次运行没有共享状态」
  assert.equal(orch!.sharedState, false)
  assert.ok(!orchTools(orch!).some((x) => x.name === 'read_state' || x.name === 'write_state'))
  assert.doesNotMatch(orchHint(orch!), /read_state/)
  // prompt 里也不能注入上一次运行的共享状态、不能教模型用这两个没注册的工具
  assert.ok(prompts.length > 0)
  for (const p of prompts) {
    assert.doesNotMatch(p, /## 共享状态/, '对话的 prompt 不注入上一次运行的共享状态')
    assert.doesNotMatch(p, /read_state/, '提示里不提没注册的工具')
  }
  assert.match(text(await callOrchTool(orch!, 'wait_agents', {})), /做完 1 个/)
  // 对话这一轮结束后停下等子任务，结果交回同一个会话接着做；对话里记成面板消息，不是用户消息
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /页面查好了/)
  const back = task.messages.find((m) => m.panel === 'helpers')
  assert.equal(back?.role, 'system')
  assert.match(back!.text, /### 页面/)
  assert.equal(task.status, 'done')
})

test('收尾建议：走提问链路交给用户选，没给选项时用默认的两个', async () => {
  const calls: { text: string; question: boolean; options?: string[]; kind?: string }[] = []
  const o = {
    self: 'a',
    hasMain: false,
    child: true,
    common: [],
    toParent: async (text: string, question: boolean, options?: string[], kind?: string) => {
      calls.push({ text, question, options, kind })
      return { ok: true, info: '已交给父对话' }
    },
  } as unknown as Orchestra
  // 子对话的工具里有它，用法说明里也写了；不是子对话时没有
  const names = (orchTools(o) as { name: string }[]).map((x) => x.name)
  assert.ok(names.includes('suggest_next_step'), '子对话能用 suggest_next_step')
  assert.match(orchHint(o), /suggest_next_step/)
  assert.ok(
    !(orchTools({ self: 'a', hasMain: false, common: [] } as unknown as Orchestra) as { name: string }[]).some(
      (x) => x.name === 'suggest_next_step',
    ),
  )
  // 没给可选做法：补上「按建议继续 / 先不做」，用户不会只剩一个空输入框
  await callOrchTool(o, 'suggest_next_step', { text: '  接着把剩下的两个流程跑完  ', remote: 'none' })
  assert.deepEqual(calls[0], {
    text: '接着把剩下的两个流程跑完',
    question: true,
    options: ['按建议继续（推荐）', '先不做，先停在这'],
    kind: 'suggestion',
  })
  // 给了就按给的：去掉空白和重复，最多 6 个
  await callOrchTool(o, 'suggest_next_step', {
    text: 'x',
    options: ['a', ' a ', 'b', '', 'c', 'd', 'e', 'f', 'g'],
    remote: 'none',
  })
  assert.deepEqual(calls[1].options, ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(calls[1].kind, 'suggestion')
  // 建议是空的：报错，不交给父对话
  const bad = await callOrchTool(o, 'suggest_next_step', { text: '   ', remote: 'none' })
  assert.match(text(bad), /text 是空的/)
  assert.equal(calls.length, 2)
})

test('收尾建议：推送 / PR / submit / 合并主干这类建议被挡下来，不生成卡片', async () => {
  const calls: { text: string }[] = []
  const o = {
    self: 'a',
    hasMain: false,
    child: true,
    common: [],
    toParent: async (text: string) => {
      calls.push({ text })
      return { ok: true, info: '已交给父对话' }
    },
  } as unknown as Orchestra
  // 声明了改远端：直接退回，让子对话重新给只有本地动作的建议（不交给父对话 = 不弹卡片）
  for (const remote of ['push', 'pr', 'submit', 'merge-main']) {
    const r = await callOrchTool(o, 'suggest_next_step', {
      text: '推送到远端让改动上线',
      options: ['现在推送（推荐）', '先不推送'],
      remote,
    })
    assert.match(text(r), /建议里不能有对外操作/)
    assert.match(text(r), /由父对话决定/)
  }
  assert.equal(calls.length, 0, '被拒绝时不能生成要用户回答的卡片')
  // 没声明也不放行：不靠文案猜，要求显式写 none
  const missing = await callOrchTool(o, 'suggest_next_step', { text: '接着跑剩下的测试' })
  assert.match(text(missing), /remote 没写/)
  assert.equal(calls.length, 0)
  // 正常建议照旧走通
  await callOrchTool(o, 'suggest_next_step', {
    text: '接着把剩下两个模块的回归测试补上',
    options: ['继续补测试（推荐）', '先停在这'],
    remote: 'none',
  })
  assert.equal(calls.length, 1)
})

test('后台命令没给名字时取命令第一行：推回结果的标题不会被换行截断', async () => {
  const names: string[] = []
  const o = {
    runBackground: async (input: { name: string }) => {
      names.push(input.name)
      return { ok: true, id: 'abc12345', info: '已放到后台（编号 abc12345）。' }
    },
  } as unknown as Orchestra
  const r = await callOrchTool(o, 'run_background', { command: 'npm ci\nnpm run build' })
  assert.match(text(r), /已放到后台/)
  assert.equal(names[0], 'npm ci', '名字带换行会把推回结果的「成功 / 失败」截掉')
  // 给了名字就照用
  await callOrchTool(o, 'run_background', { command: 'npm ci\nnpm run build', name: '装依赖' })
  assert.equal(names[1], '装依赖')
})

/**
 * spawn_agents 的顶层 agent / tier / resume：整批的默认值。
 * 以前只读 tasks[i]，模型把 resume 写在顶层时被静默丢掉，复看的评审退回默认「子任务」角色 + 新会话，
 * 提示词也跟着换成子任务那一套，而结果看起来和正常复看一样，看不出走错了角色。
 */
test('spawn_agents 顶层 agent / tier / resume：整批默认值，任务里写了以任务里的为准', async () => {
  const lists: HelperSpec[][] = []
  const o = {
    self: 'a',
    hasMain: false,
    common: [],
    spawn: (list: HelperSpec[], _step?: string) => {
      lists.push(list)
      return { ids: list.map((_, i) => `a/sub/h${i + 1}`) }
    },
  } as unknown as Orchestra
  // 顶层 resume：解析出来要落到那个任务上；没写 agent 就不带，交给引擎沿用原任务的角色
  await callOrchTool(o, 'spawn_agents', { resume: 'a/sub/h1', tasks: [{ title: '复看', instructions: '确认修复' }] })
  assert.equal(lists[0][0].resume, 'a/sub/h1')
  assert.equal(lists[0][0].agent, undefined, '不写 agent 时不补默认「子任务」，由引擎跟随原任务的角色')
  // 顶层 agent / tier 也当默认值；同一批里任务自己写的优先
  await callOrchTool(o, 'spawn_agents', {
    agent: '评审',
    tier: 'high',
    tasks: [
      { title: '甲', instructions: '看甲' },
      { title: '乙', instructions: '看乙', agent: '测试', tier: 'low' },
    ],
  })
  assert.equal(lists[1][0].agent, '评审')
  assert.equal(lists[1][0].tier, 'high')
  assert.equal(lists[1][1].agent, '测试')
  assert.equal(lists[1][1].tier, 'low')
  // 顶层 resume 只配一个任务：一个会话只能接着跑一轮，一批多个时说不清谁接它
  const many = await callOrchTool(o, 'spawn_agents', {
    resume: 'a/sub/h1',
    tasks: [
      { title: '甲', instructions: 'x' },
      { title: '乙', instructions: 'y' },
    ],
  })
  assert.match(text(many), /顶层 resume 只能配一个子任务/)
  // 字段名写错不能静默忽略：调用方以为生效了，实际派出去的是另一回事
  const typo = await callOrchTool(o, 'spawn_agents', {
    resume_id: 'a/sub/h1',
    tasks: [{ title: '复看', instructions: '确认修复' }],
  })
  assert.match(text(typo), /不认得顶层字段「resume_id」/)
  // 写了但不是字符串：不能当成「没写」落到顶层默认值，调用方看不出参数没生效
  const wrongType = await callOrchTool(o, 'spawn_agents', {
    tasks: [{ title: '复看', instructions: '确认', resume: ['a/sub/h1'] }],
  })
  assert.match(text(wrongType), /tasks\[0\]\.resume 要写字符串/)
  assert.equal(lists.length, 2, '被拒的调用不派子任务')
})

/**
 * resume 的角色：不写沿用原任务的，写了用写的，都不是默认「子任务」。
 * 引擎层跑真流程，顺带确认提示词 / CLI / 会话都跟着这个角色走（runHelper 按 step.agentId 取角色）。
 */
test('resume：不写 agent 沿用原任务的角色，写了用写的，非 resume 不带 agent 才是默认子任务', async () => {
  const review = { ...agent('r', '评审'), origin: 'builtin:reviewer' }
  const helper = { ...agent('h', '子任务'), origin: 'builtin:helper' }
  const team = [agent('m', '主管'), review, helper]
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', prompt: '复看' } as never, undefined, '', 't6'),
    id: 't6',
  } as Task
  const calls: AgentCall[] = []
  let round = 0
  const h: EngineHost = {
    task,
    agents: team,
    workflows: [],
    prompt: '复看',
    changed: () => {},
    newId: () => `id${task.messages.length}`,
    runAgent: async (call) => {
      calls.push(call)
      if (call.step?.slot === 'sub') return { ok: true, text: '做完了' }
      round++
      // 评审代码改动要带交接单：第一次派评审必填 goal、checks
      const brief = { goal: '修好复看角色', checks: 'npm run test:unit 通过' }
      if (round === 1) {
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          tasks: [{ title: '评审改动', instructions: '看代码', agent: '评审', review: brief }],
        })
        assert.match(text(r), /@chat\/sub\/h1/)
      }
      if (round === 2) {
        // 不写 agent 的新子任务：默认「子任务」角色，不能因为要沿用别的角色就跟着变
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          tasks: [{ title: '查日志', instructions: '查一下' }],
        })
        assert.match(text(r), /@chat\/sub\/h2/)
      }
      if (round === 3) {
        // 复看：顶层 resume、不写 agent
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          resume: '@chat/sub/h1',
          tasks: [{ title: '复看修复', instructions: '确认这几条' }],
        })
        assert.match(text(r), /@chat\/sub\/h3/)
      }
      if (round === 4) {
        // 复看：显式写「评审」，和没写时一致
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          resume: '@chat/sub/h1',
          agent: '评审',
          tasks: [{ title: '再复看', instructions: '确认增量' }],
        })
        assert.match(text(r), /@chat\/sub\/h4/)
      }
      return { ok: true, text: '好了' }
    },
  }
  await runEngineTurn(h)
  const step = (id: string) => task.steps.find((s) => s.id === id)!
  const first = step('@chat/sub/h1')
  assert.equal(first.agentId, 'r', '点名派给评审')
  assert.equal(step('@chat/sub/h2').agentId, 'h', '不是 resume 又不写 agent：还是默认「子任务」')
  // 复看两条都沿用原任务的评审角色，并接着原来的会话
  for (const id of ['@chat/sub/h3', '@chat/sub/h4']) {
    assert.equal(step(id).agentId, 'r', `${id}：接着评审的会话就还是评审`)
    assert.equal(step(id).session, first.session || first.id, `${id}：接着原来的会话`)
  }
  const subs = calls.filter((c) => c.step?.slot === 'sub')
  assert.deepEqual(
    subs.map((c) => c.agentId),
    ['r', 'h', 'r', 'r'],
    '实际执行的角色和记录里的一致（提示词按这个角色取）',
  )
})

test('resume：原任务的角色已经不在了就报错，不悄悄退回默认子任务', async () => {
  const helper = { ...agent('h', '子任务'), origin: 'builtin:helper' }
  const team = [agent('m', '主管'), agent('q', '测试'), helper]
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', prompt: '复看' } as never, undefined, '', 't7'),
    id: 't7',
  } as Task
  let round = 0
  let error = ''
  const h: EngineHost = {
    task,
    agents: team,
    workflows: [],
    prompt: '复看',
    changed: () => {},
    newId: () => `id${task.messages.length}`,
    runAgent: async (call) => {
      if (call.step?.slot === 'sub') return { ok: true, text: '查完了' }
      round++
      if (round === 1) {
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          tasks: [{ title: '查日志', instructions: '查一下', agent: '测试' }],
        })
        assert.match(text(r), /@chat\/sub\/h1/)
        // 角色被删掉（用户删了「测试」这个角色）
        team.splice(
          team.findIndex((a) => a.id === 'q'),
          1,
        )
      }
      if (round === 2) {
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          resume: '@chat/sub/h1',
          tasks: [{ title: '复看', instructions: '确认' }],
        })
        error = text(r)
      }
      return { ok: true, text: '好了' }
    },
  }
  await runEngineTurn(h)
  assert.match(error, /原来的角色已经找不到了/, '原角色没了要明说，不能派成「子任务」')
  assert.match(error, /显式写 agent/)
  assert.equal(task.steps.filter((s) => s.parentId === '@chat').length, 1, '被拒的复看不新建子任务')
})

test('点名的角色不存在：报错，不落到默认「子任务」', async () => {
  const helper = { ...agent('h', '子任务'), origin: 'builtin:helper' }
  const team = [agent('m', '主管'), helper]
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', prompt: '复看' } as never, undefined, '', 't8'),
    id: 't8',
  } as Task
  let error = ''
  const h: EngineHost = {
    task,
    agents: team,
    workflows: [],
    prompt: '复看',
    changed: () => {},
    newId: () => `id${task.messages.length}`,
    runAgent: async (call) => {
      if (call.step?.slot === 'sub') return { ok: true, text: '查完了' }
      // 顶层和任务级都写错：写入的角色找不到时不能悄悄派出默认「子任务」
      const r = await callOrchTool(call.orch!, 'spawn_agents', {
        agent: '评审',
        tasks: [{ title: '复看', instructions: '确认' }],
      })
      error = text(r)
      return { ok: true, text: '好了' }
    },
  }
  await runEngineTurn(h)
  assert.match(error, /agent 写的「评审」不是已有的角色/, '点名的角色不存在要报错')
  assert.match(error, /get_status/, '要告诉调用方去哪看现有角色')
  assert.equal(task.steps.filter((s) => s.parentId === '@chat').length, 0, '不是落到默认「子任务」派出去')
})

test('子对话的工具清单：计划、后台命令、收尾合并都在；子任务只有查状态、后台命令和传话', () => {
  const namesOf = (o: object) => (orchTools(o as unknown as Orchestra) as { name: string }[]).map((x) => x.name)
  // 用户报过：子对话里 `set_plan`、`run_background`、`submit_merge` 不可见时，模型只能改用普通命令跑验证
  const child = namesOf({
    self: '@chat',
    hasMain: false,
    child: true,
    plans: true,
    canSubmit: true,
    canBackground: true,
    canBeginEdit: true,
    common: [],
  })
  for (const n of [
    'set_plan',
    'finish_plan',
    'run_background',
    'submit_merge',
    'begin_edit',
    'message_parent',
    'suggest_next_step',
  ])
    assert.ok(child.includes(n), `子对话能用 ${n}`)
  // 子任务只做派给它的那一件事：计划、收尾合并、开分支、找父对话都不给它
  const helper = namesOf({ self: '@chat/sub/h1', hasMain: false, helper: true, canBackground: true, common: [] })
  for (const n of ['set_plan', 'finish_plan', 'submit_merge', 'begin_edit', 'message_parent', 'spawn_agents'])
    assert.ok(!helper.includes(n), `子任务没有 ${n}`)
  assert.ok(helper.includes('run_background'), '子任务也能用后台命令：结果推回派它的对话')
  assert.ok(helper.includes('send_message'), '子任务能和其他节点传话')
})
