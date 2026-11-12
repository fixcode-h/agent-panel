import assert from 'node:assert/strict'
import { autoSubmit } from './submit-test-kit.ts'
import test from 'node:test'
import { FlowRun } from '../shared/tasks/flow-schema.ts'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { chatModePart } from '../shared/chat-prompt.ts'
import { runEngineTurn } from '../shared/engine.ts'
import type { AgentCall, EngineHost, HelperSpec, Orchestra } from '../shared/engine-host.ts'
import { activePlan, applyPlan } from '../shared/plan.ts'
import { callOrchTool, orchHint, orchTools } from './orch-mcp.ts'
import { askMcpApi, openAskBridge } from './ask-mcp.ts'
import { PANEL_TOOL_NAMES } from '../shared/panel-tools.ts'

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
      autoSubmit(call)
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
        // 超长的值和消息拒绝写入并说明，不悄悄截断（ADR 0041 开放问题）
        const huge = 'x'.repeat(20001)
        const big = await callOrchTool(o, 'write_state', { key: 'interface', value: huge })
        assert.equal(big.isError, true)
        assert.match(text(big), /20001 字.*没有写入/)
        assert.match(text(await callOrchTool(o, 'read_state', {})), /interface（v1/)
        assert.match(text(await callOrchTool(o, 'send_message', { to: '测试', text: huge })), /没有写入/)
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
          assert.match(
            text(await callOrchTool(o, 'start_workflow', { input: '跑一遍' })),
            /只有项目里的父对话能启动工作流/,
          )
          const names = orchTools(o).map((x) => x.name)
          assert.ok(!names.includes('spawn_agents') && !names.includes('start_workflow'), names.join(','))
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
      autoSubmit(call)
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

test('spawn_agents 带 step：子任务失败或没跑起来，这一步退回进行中并写清要修什么（ADR 0032）', async () => {
  const { plan } = await spawnWithStep(false)
  assert.notEqual(plan.steps[0].status, 'done', '子任务没成功，不能盲目标完成')
  // 计划里没有「失败」：退回进行中、备注写「需要修复」，对话查问题修好重做
  assert.equal(plan.steps[0].status, 'running')
  assert.match(plan.steps[0].note, /需要修复：.*没成功/)
})

test('spawn_agents 带 step：同一批一成败，这一步要修而不是完成', async () => {
  // 这组「甲成功、乙失败」挂在第 2 步上：只要还有一只没成功，整步就不能算完成
  const { plan } = await spawnWithStep(false, false, true)
  assert.equal(plan.steps[1].status, 'running', '一只成功一只失败：整步还要修，不能算完成')
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
  const base = { self: 'n1', common: [], canSpawn: true, team: true } as unknown as Parameters<typeof orchTools>[0]
  const props = (o: Parameters<typeof orchTools>[0]) =>
    (orchTools(o).find((x) => x.name === 'spawn_agents')!.inputSchema as { properties: Record<string, unknown> })
      .properties
  assert.equal(props({ ...base, plans: true, helper: false }).step !== undefined, true)
  assert.equal(props({ ...base, plans: false, helper: false }).step, undefined)
})

test('spawn_agents / create_conversation 的字段描述带上派单纪律', () => {
  // 描述就是模型看到的用法说明：只写「不写跟你一样」「不写取 instructions 第一行」会导向低档派单和同标题
  const o = {
    self: 'a',
    common: [],
    coordinator: true,
    plans: false,
    canSpawn: true,
  } as unknown as Parameters<typeof orchTools>[0]
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
    flowRun: FlowRun.parse({ owner: 'p' }),
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
  // 工作流节点仍然拿得到共享状态：这个能力不能因为对话模式不注册就被一起砍掉
  // （工具表另有一处 deepEqual 断言含 read_state / write_state；节点内 read_state 能读出 a 写的值）
  const withState = task.runs[0]?.state.interface
  assert.ok(withState && withState.version >= 1, '节点 a 写的共享状态留在这次运行里')
  assert.ok(task.messages.some((m) => m.step === 'a' && /派出 2 个子角色/.test(m.text)))
})

test('编排工具挂在面板的 MCP 上：列出工具、调用、结束后失效', async () => {
  const w = workflow()
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: 'x' } as never, w, '', 't2'),
    flowRun: FlowRun.parse({ owner: 'p' }),
    id: 't2',
  } as Task
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
  // 服务端只带 Node 类型，Response.json() 是 unknown（DOM 里是 any）；测试按接口约定直接读字段，放宽成 any
  const list: any = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
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
    'submit_verdict',
  ])
  const st: any = await (
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } })
  ).json()
  assert.match(st.result.content[0].text, /- a｜实现（开发）【你】：完成/)
  s.close()
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 404)
})

test('编排工具：通用 Agent 列在 spawn_agents 和用法说明里', async () => {
  const o = {
    self: 'a',
    canSpawn: true,
    team: true,
    common: [{ name: '代码侦察', description: '只读定位代码' }],
  } as unknown as Orchestra
  const s = openAskBridge({ orch: o })
  const path = new URL(s.url).pathname.replace('/api/mcp', '')
  const res = await askMcpApi().request(path, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    headers: { 'content-type': 'application/json' },
  })
  const tools = ((await res.json()) as any).result.tools
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
    // 对话里跑过工作流：task.runs 里留着上一次运行的记录和它写下的共享状态
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
      autoSubmit(call)
      if (call.step?.slot === 'sub') {
        // 对话里的子任务用不上共享状态：即使对话跑过工作流、task.runs 还留着上一次运行，
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
  // 结果已经自动交回过：再调等待工具不重交（以前每调一次都把做完的全部再交一遍）
  assert.match(text(await callOrchTool(orch!, 'wait_agents', {})), /都已经交回过了/)
  // 对话这一轮结束后停下等子任务，结果交回同一个会话接着做；对话里记成面板消息，不是用户消息
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /页面查好了/)
  const back = task.messages.find((m) => m.panel === 'helpers')
  assert.equal(back?.role, 'system')
  assert.match(back!.text, /### 页面/)
  // 交回的是哪几个子任务记在消息上：界面按它数个数，不数正文里的标题
  assert.equal(back!.results?.length, 1)
  assert.equal(task.status, 'done')
})

test('收尾建议：走提问链路交给用户选，没给选项时用默认的两个', async () => {
  const calls: { text: string; question: boolean; options?: string[]; kind?: string }[] = []
  const o = {
    self: 'a',
    child: true,
    team: true,
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
    !(orchTools({ self: 'a', common: [] } as unknown as Orchestra) as { name: string }[]).some(
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

test('后台命令只收长命令：写文件、快命令拒收；命令先过守卫；开发服务器按常驻服务跑', async () => {
  const got: { command: string; service?: boolean }[] = []
  const guarded: string[] = []
  const o = {
    runBackground: async (input: { command: string; service?: boolean }) => {
      got.push(input)
      return { ok: true, id: 'abc12345', info: '已放到后台（编号 abc12345）。' }
    },
    guardCommand: async (command: string) => {
      guarded.push(command)
      return /git push/.test(command) ? '【面板】还没拿到推送授权' : ''
    },
  } as unknown as Orchestra
  // 用户 2026-11-05 报：写文件的命令也交给了后台
  const write = await callOrchTool(o, 'run_background', { command: "cat > a.md <<'EOF'\nnpm run test:e2e\nEOF" })
  assert.match(text(write), /不用来写文件/)
  assert.match(text(await callOrchTool(o, 'run_background', { command: 'git status' })), /几秒就能跑完/)
  assert.equal(got.length, 0, '拒收的不交给面板')
  // 守卫：和 CLI 命令工具同一套，不能借后台命令绕过推送授权
  const push = await callOrchTool(o, 'run_background', { command: 'npm run build && git push' })
  assert.match(text(push), /推送授权/)
  assert.equal(got.length, 0)
  await callOrchTool(o, 'run_background', { command: 'npm run test:e2e' })
  await callOrchTool(o, 'run_background', { command: 'npm run dev' })
  assert.deepEqual(
    got.map((x) => [x.command, !!x.service]),
    [
      ['npm run test:e2e', false],
      ['npm run dev', true],
    ],
  )
  assert.ok(guarded.includes('npm run test:e2e'))
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
  // params 和 agent 一样：顶层是整批默认值，任务里写的优先；写成字符串不能静默丢掉（派出去就是默认那套做法）
  await callOrchTool(o, 'spawn_agents', {
    params: { task: '清理用例' },
    tasks: [
      { title: '甲', instructions: 'x' },
      { title: '乙', instructions: 'y', params: { task: '设计用例' } },
    ],
  })
  assert.deepEqual(
    lists[2].map((s) => s.params),
    [{ task: '清理用例' }, { task: '设计用例' }],
  )
  // review 同理：顶层交接单给没写自己那份的任务
  await callOrchTool(o, 'spawn_agents', {
    review: { goal: '修好', checks: '单测通过' },
    tasks: [
      { title: '甲', instructions: 'x' },
      { title: '乙', instructions: 'y', review: { goal: '另一件' } },
    ],
  })
  assert.deepEqual(
    lists[3].map((s) => s.review?.goal),
    ['修好', '另一件'],
  )
  const strParams = await callOrchTool(o, 'spawn_agents', { tasks: [{ instructions: 'x', params: '{"task":1}' }] })
  assert.match(text(strParams), /params 要写对象/)
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
  assert.equal(lists.length, 4, '被拒的调用不派子任务')
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
      autoSubmit(call)
      calls.push(call)
      // 评审子任务用工具交结论（面板只认它；不交会被补问一次，见 shared/submitted.ts）
      if (call.step?.slot === 'sub') {
        if (call.step.agentId === 'r') call.orch?.submitVerdict?.({ verdict: 'pass' })
        return { ok: true, text: '做完了' }
      }
      round++
      // 评审代码改动要带交接单：第一次派评审必填 goal、checks
      const brief = { goal: '修好复看角色', checks: 'npm run test:unit 通过' }
      if (round === 1) {
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          // 交接单写在顶层（模型照着顶层 agent 的写法常这样写）：当整批默认值，不拒
          agent: '评审',
          review: brief,
          tasks: [{ title: '评审改动', instructions: '看代码' }],
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
        // 复看：显式写「评审」，和没写时一致；id 丢了开头的「@」也认得（用户截图里模型就这样写）
        const r = await callOrchTool(call.orch!, 'spawn_agents', {
          resume: 'chat/sub/h1',
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
      autoSubmit(call)
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
  const team = [agent('m', '主管'), helper, { ...agent('c', '写作'), scope: 'chat' as const }]
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
      autoSubmit(call)
      if (call.step?.slot === 'sub') return { ok: true, text: '查完了' }
      // 顶层和任务级都写错：写入的角色找不到时不能悄悄派出默认「子任务」
      const r = await callOrchTool(call.orch!, 'spawn_agents', {
        agent: '评审',
        tasks: [{ title: '复看', instructions: '确认' }],
      })
      error = text(r)
      // 点名 Chat 角色（ADR 0038）：只能在 Chat 页用，同样拒绝，不派出去
      const c = await callOrchTool(call.orch!, 'spawn_agents', {
        agent: '写作',
        tasks: [{ title: '润色', instructions: '改' }],
      })
      chatErr = text(c)
      return { ok: true, text: '好了' }
    },
  }
  let chatErr = ''
  await runEngineTurn(h)
  assert.match(chatErr, /「写作」是 Chat 角色/)
  assert.match(error, /agent 写的「评审」不是已有的角色/, '点名的角色不存在要报错')
  assert.match(error, /get_status/, '要告诉调用方去哪看现有角色')
  assert.equal(task.steps.filter((s) => s.parentId === '@chat').length, 0, '不是落到默认「子任务」派出去')
})

/**
 * 面板工具按身份裁剪的快照：docs/modules/server-exec/README.md「面板工具按身份裁剪」照这张表写（README 不写个数）。
 * 字段和 shared/engine.ts 的 makeOrchestra 一一对应，默认全关，每个身份只开 makeOrchestra 会给它开的；
 * 下面的用例再拿真实 makeOrchestra 造的 Orchestra 核对其中几项，免得表里的字段组合和引擎各说各的。
 * 加 / 删一个工具会让这里失败：按新清单改表，同一个提交把 README 那一节一起改（以前 README 五组数字全对不上）
 */
const okCb = async () => ({ ok: true, info: '' })
const OFF = {
  self: '@chat',
  planner: false,
  common: [],
  helper: false,
  canSpawn: false,
  team: false,
  autoReturn: false,
  sharedState: false,
  planning: false,
  plans: false,
  coordinator: false,
  capabilities: false,
  inlineEdit: false,
  child: false,
  claims: false,
  canBackground: false,
  canSubmit: false,
  isolated: false,
  canBeginEdit: false,
  ueBuild: '',
  parentOf: false,
  peers: false,
  lessons: undefined,
  p4Split: undefined,
  cherryPick: undefined,
  askPush: undefined,
}
const LESSONS = { find: async () => '', record: okCb }
// 子任务只查教训不记（makeOrchestra 给子任务的 lessons 没有 record）
const READ_LESSONS = { find: async () => '' }
const toolNames = (o: object) => orchTools({ ...OFF, ...o } as unknown as Orchestra).map((x) => x.name)
// 项目里的对话（顶层、子对话）共有的：chat=true、不是子任务、在项目里（能派子任务、有并行的子任务可查可传话）
// endTurn：对话（Agent 模式）交代这一轮怎么结束（shared/end-turn.ts），Chat 页、子任务、工作流节点没有；
// requestUserAction（等你操作，shared/user-action.ts）和它同样只给对话
const CONV = {
  canSpawn: true,
  team: true,
  autoReturn: true,
  plans: true,
  canBackground: true,
  lessons: LESSONS,
  endTurn: okCb,
  requestUserAction: okCb,
}
const TOP = { ...CONV, parentOf: true }
const CHILD = { ...CONV, child: true, canSubmit: true }
const BG = ['run_background', 'check_background', 'stop_background']
const LESSON_TOOLS = ['project_lessons', 'record_lesson']
const TAIL = ['spawn_agents', 'stop_subtask', 'send_message', 'read_messages']
const COORD = ['list_conversations', 'create_conversation', 'send_to_conversation']
// 能启动工作流的父对话（planning）：起运行和操作运行的一组（server/workflow-tools.ts）
const WF = [
  'start_workflow',
  'list_workflows',
  'message_workflow',
  'revise_workflow',
  'answer_workflow',
  'stop_workflow',
  'finish_workflow',
]
const CHILD_TOOLS = ['message_parent', 'suggest_next_step', 'submit_merge']

const IDENTITIES: [string, object, string[]][] = [
  // Chat 模式（ADR 0038）：不派子任务、没有并行节点可传话；面板计划只在 Agent 模式，Chat 用 CLI 自带的待办
  ['Chat 模式·助手（无项目，没有派单和传话）', { autoReturn: true, canBackground: true }, BG],
  [
    '项目顶层·协调器（canDelegate）',
    { ...TOP, coordinator: true, peers: true },
    [
      'get_status',
      ...BG,
      'set_plan',
      'finish_plan',
      ...COORD,
      'list_peers',
      'message_peer',
      'finish_child',
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  [
    '项目顶层·协调器 全开（canPlan + 就地改动 + 挂能力 + UE + P4 + cherry-pick + 推送问一次）',
    {
      ...TOP,
      coordinator: true,
      peers: true,
      planning: true,
      inlineEdit: true,
      capabilities: true,
      ueBuild: 'parent',
      p4Split: okCb,
      cherryPick: okCb,
      askPush: okCb,
    },
    [
      'get_status',
      ...BG,
      'set_plan',
      'finish_plan',
      ...WF,
      ...COORD,
      'begin_inline_edit',
      'end_inline_edit',
      'use_capability',
      'request_build',
      'list_peers',
      'message_peer',
      'finish_child',
      'p4_split_changelists',
      'cherry_pick',
      'ask_push',
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  [
    '项目顶层·非统筹',
    TOP,
    [
      'get_status',
      ...BG,
      'set_plan',
      'finish_plan',
      'finish_child',
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  [
    // 不能分派子对话的顶层对话没有 start_workflow（只给协调器，ADR 0044）：makeOrchestra 给的 planning 是 false
    '项目顶层·非统筹 全开（按需开分支 + 挂能力 + P4 + cherry-pick + 推送问一次）',
    { ...TOP, canBeginEdit: true, capabilities: true, p4Split: okCb, cherryPick: okCb, askPush: okCb },
    [
      'get_status',
      'begin_edit',
      ...BG,
      'set_plan',
      'finish_plan',
      'use_capability',
      'finish_child',
      'p4_split_changelists',
      'cherry_pick',
      'ask_push',
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  // 用户报过：子对话里 set_plan、run_background、submit_merge 不可见时，模型只能改用普通命令跑验证
  [
    '子对话·共用目录',
    { ...CHILD, claims: true },
    [
      'get_status',
      ...BG,
      'set_plan',
      'finish_plan',
      ...CHILD_TOOLS,
      'claim_files',
      'release_files',
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  [
    '子对话·独立分支',
    { ...CHILD, isolated: true },
    [
      'get_status',
      ...BG,
      'set_plan',
      'finish_plan',
      ...CHILD_TOOLS,
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  [
    '子对话·要改时才开分支（还没开）',
    { ...CHILD, canBeginEdit: true },
    [
      'get_status',
      'begin_edit',
      ...BG,
      'set_plan',
      'finish_plan',
      ...CHILD_TOOLS,
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  [
    // 子对话不启动工作流（ADR 0044）：角色开了 canPlan 也没有 start_workflow
    '子对话·共用目录 全开（挂能力 + UE + P4）',
    { ...CHILD, claims: true, capabilities: true, ueBuild: 'child', p4Split: okCb },
    [
      'get_status',
      ...BG,
      'set_plan',
      'finish_plan',
      'use_capability',
      ...CHILD_TOOLS,
      'request_build',
      'claim_files',
      'release_files',
      'p4_split_changelists',
      'end_turn',
      'request_user_action',
      ...LESSON_TOOLS,
      ...TAIL,
    ],
  ],
  // 子任务只做派给它的那一件事：计划、收尾合并、开分支、找父对话、派子任务、记教训都不给它；后台命令的结果推回派它的对话
  [
    '子任务·对话派的',
    {
      self: '@chat/sub/h1',
      helper: true,
      team: true,
      canBackground: true,
      lessons: READ_LESSONS,
      submitResult: okCb,
      submitVerdict: okCb,
    },
    ['get_status', ...BG, 'project_lessons', 'send_message', 'read_messages', 'submit_result', 'submit_verdict'],
  ],
  [
    '子任务·工作流节点派的（工作流任务里）',
    {
      self: 'a/sub/h1',
      helper: true,
      team: true,
      sharedState: true,
      lessons: READ_LESSONS,
      submitResult: okCb,
      submitVerdict: okCb,
    },
    [
      'get_status',
      'project_lessons',
      'read_state',
      'write_state',
      'send_message',
      'read_messages',
      'submit_result',
      'submit_verdict',
    ],
  ],
  [
    '工作流节点（工作流任务里）',
    { self: 'a', canSpawn: true, team: true, sharedState: true, lessons: LESSONS, submitVerdict: okCb },
    [
      'get_status',
      ...LESSON_TOOLS,
      'read_state',
      'write_state',
      'spawn_agents',
      'stop_subtask',
      'wait_agents',
      'send_message',
      'read_messages',
      'submit_verdict',
    ],
  ],
  [
    '工作流节点（工作流子对话跑的，共用目录）',
    {
      self: 'a',
      canSpawn: true,
      team: true,
      sharedState: true,
      lessons: LESSONS,
      canBackground: true,
      child: true,
      canSubmit: true,
      claims: true,
    },
    [
      'get_status',
      ...BG,
      ...CHILD_TOOLS,
      'claim_files',
      'release_files',
      ...LESSON_TOOLS,
      'read_state',
      'write_state',
      'spawn_agents',
      'stop_subtask',
      'wait_agents',
      'send_message',
      'read_messages',
    ],
  ],
]

/**
 * 按 server/tasks/run.ts 的接线造宿主，只给这个身份 run.ts 会给的回调：coordinatorRole 才有 peers，
 * 子对话才有 messageParent / submitMerge / claimFiles，顶层才有 finishChild，chat 任务才有 runBackground，
 * 有项目才有 lessons。run.ts 改了接线这里不会自己失败，改那边时对照着改
 */
function identityHost(op: {
  parent?: boolean
  delegate?: boolean
  mode?: 'chat' | 'workflow'
  chat?: boolean
  /** Chat 模式里用着旧的 Agent 角色（ADR 0038 以前的对话）：角色开着分派和计划，Chat 的能力上限照样管住它 */
  legacy?: boolean
}) {
  const seen = new Map<string, Orchestra>()
  const mk = (id: string, name: string, extra: object = {}): Agent => ({
    ...AgentInput.parse({ name, ...extra }),
    id,
    createdAt: '',
    updatedAt: '',
  })
  const w = Workflow.parse({
    id: 'wf1',
    createdAt: '',
    updatedAt: '',
    name: '单节点',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [{ id: 'a', title: '实现', agentId: 'w', instructions: '写代码。' }],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'end' },
        ],
      },
    ],
  })
  const mode = op.mode ?? 'chat'
  const flow = mode === 'workflow' ? w : undefined
  const projectId = op.chat ? '' : 'p'
  const task = {
    ...newTask({ projectId, mode, prompt: '做', workflowId: flow ? 'wf1' : '' } as never, flow, '', 'T'),
    id: 'T',
    // Chat 模式的对话不选角色（agentId 为空）：运行时按内置「助手」跑（chatRoleFor），这条路径一并测到
    agentId: (mode === 'chat' && !op.chat) || op.legacy ? 'exec' : '',
    parentTaskId: op.parent ? 'P' : undefined,
    // 工作流节点只在工作流运行里跑（父对话 start_workflow 起的）
    ...(flow && { flowRun: FlowRun.parse({ owner: 'P' }) }),
  } as unknown as Task
  const coordinatorRole = !op.parent && !!op.delegate && !!projectId
  const host = {
    task,
    agents: [
      mk('exec', '执行', { canDelegate: !!op.delegate || !!op.legacy, canPlan: !!op.legacy }),
      mk('w', '开发'),
      mk('chat', '助手', { origin: 'builtin:chat', scope: 'chat', kind: 'advanced' }),
    ],
    workflows: [w],
    workflow: flow,
    prompt: '做',
    changed: () => {},
    newId: () => Math.random().toString(36).slice(2),
    messageParent: op.parent ? okCb : undefined,
    submitMerge: op.parent ? okCb : undefined,
    finishChild: op.parent || !projectId ? undefined : okCb,
    peers: coordinatorRole ? async () => [] : undefined,
    messagePeer: coordinatorRole ? okCb : undefined,
    runBackground: mode === 'chat' ? okCb : undefined,
    claimFiles: op.parent ? () => ({ ok: true, info: '' }) : undefined,
    releaseFiles: op.parent ? () => ({ ok: true, info: '' }) : undefined,
    lessons: projectId ? { list: async () => [], globals: async () => [], record: okCb } : undefined,
    listConversations: async () => [],
    // 对话 / 节点第一次被调用时记下它的 Orchestra，再派一个子任务把子任务的也记下来
    runAgent: async (call: AgentCall) => {
      autoSubmit(call)
      const o = call.orch!
      const sub = call.step?.slot === 'sub'
      const key = `${o.self.startsWith('@chat') ? 'chat' : 'node'}${sub ? '-helper' : ''}`
      if (!seen.has(key)) {
        seen.set(key, o)
        if (!sub && o.canSpawn) await callOrchTool(o, 'spawn_agents', { tasks: [{ title: '查', instructions: '查' }] })
        if (key === 'node') await callOrchTool(o, 'wait_agents', { seconds: 3 })
      }
      return { ok: true, text: '好' }
    },
  } as unknown as EngineHost
  return { host, seen }
}

test('面板工具按身份裁剪：每个身份的完整清单，真实 makeOrchestra 造的和表一致，名字都登记过', async () => {
  for (const [who, o, want] of IDENTITIES) assert.deepEqual(toolNames(o), want, who)
  const want = new Map(IDENTITIES.map(([who, , list]) => [who, list]))
  const real = async (op: Parameters<typeof identityHost>[0]) => {
    const { host, seen } = identityHost(op)
    await runEngineTurn(host)
    return (k: string) => orchTools(seen.get(k)!).map((x) => x.name)
  }
  const top = await real({ delegate: true })
  assert.deepEqual(top('chat'), want.get('项目顶层·协调器（canDelegate）'))
  assert.deepEqual(top('chat-helper'), want.get('子任务·对话派的'))
  assert.deepEqual((await real({}))('chat'), want.get('项目顶层·非统筹'))
  assert.deepEqual((await real({ parent: true }))('chat'), want.get('子对话·共用目录'))
  assert.deepEqual((await real({ chat: true }))('chat'), want.get('Chat 模式·助手（无项目，没有派单和传话）'))
  // Chat 里用着旧 Agent 角色（canPlan、canDelegate）：清单和助手一样，拿不到 start_workflow、create_conversation
  assert.deepEqual(
    (await real({ chat: true, legacy: true }))('chat'),
    want.get('Chat 模式·助手（无项目，没有派单和传话）'),
  )
  const flow = await real({ mode: 'workflow' })
  assert.deepEqual(flow('node'), want.get('工作流节点（工作流任务里）'))
  assert.deepEqual(flow('node-helper'), want.get('子任务·工作流节点派的（工作流任务里）'))
  // 新工具要登记进名字总表，不然对话里显示成 mcp__panel-xxxx__ 这串原始名字（docs/lessons/messages.md）。
  // 老任务里的 @main（主 Agent）也一起查：run_workflow、close_run、ask_main 已经删了，没有身份拿得到
  const dead = [{ self: '@main', planner: true, sharedState: true }]
  const all = new Set([...IDENTITIES.map(([, o]) => o), ...dead].flatMap(toolNames))
  for (const n of all) assert.ok((PANEL_TOOL_NAMES as readonly string[]).includes(n), `${n} 没登记进 PANEL_TOOL_NAMES`)
})

test('Chat 模式：只有后台命令，没有 get_status / spawn_agents 和面板计划；说明只讲后台命令，都没有时为空', () => {
  const namesOf = (o: object) => (orchTools(o as unknown as Orchestra) as { name: string }[]).map((x) => x.name)
  // 用户要求 Chat 模式不派子任务、不开子对话（ADR 0038）；计划用 CLI 自带的待办，面板计划只在 Agent 模式
  const chat = { self: '@chat', autoReturn: true, canBackground: true, common: [] }
  assert.deepEqual(namesOf(chat).sort(), ['check_background', 'run_background', 'stop_background'])
  const hint = orchHint(chat as unknown as Orchestra)
  assert.match(hint, /run_background/)
  assert.doesNotMatch(hint, /spawn_agents|派完结束这一轮|get_status|set_plan/)
  assert.deepEqual(namesOf({ ...chat, canBackground: false }), [])
  assert.equal(orchHint({ ...chat, canBackground: false } as unknown as Orchestra), '')
  // 项目里的对话（能派、有并行）照旧能派子任务、查状态
  const conv = namesOf({ ...chat, canSpawn: true, team: true })
  assert.ok(conv.includes('spawn_agents') && conv.includes('get_status'))
})

test('Chat 模式的一轮：提示词另起一套，不带项目对话的授权、工作流、执行方式；Agent 模式不变', async () => {
  // 沙盒实测（ADR 0038）：以前 Chat 页读到「调用面板工具 ask_push」「你是项目对话」，可这一轮根本没有这些工具
  const run = async (projectId: string) => {
    const task = {
      ...newTask({ projectId, mode: 'chat', prompt: '做', workflowId: '', agentId: '' } as never, undefined, '', 'T'),
      id: 'T',
    } as unknown as Task
    let prompt = ''
    let names: string[] = []
    const host = {
      task,
      agents: [],
      workflows: [],
      prompt: '做',
      changed: () => {},
      newId: () => Math.random().toString(36).slice(2),
      policy: { push: 'ask', tools: [] },
      askPush: async () => ({ allow: true }),
      runBackground: okCb,
      runAgent: async (call: AgentCall) => {
        autoSubmit(call)
        prompt = call.prompt
        names = orchTools(call.orch!).map((x) => x.name)
        return { ok: true, text: '好' }
      },
    } as unknown as EngineHost
    await runEngineTurn(host)
    return { prompt, names }
  }
  const chat = await run('')
  assert.deepEqual(chat.names, BG)
  assert.match(chat.prompt, /## Chat 模式/)
  assert.match(chat.prompt, /## 长命令放到后台/)
  // Chat 页不写总结卡（用户 2026-11-01 定）；这个宿主没说 CLI 的待办能显示，就不许诺面板会显示
  assert.doesNotMatch(chat.prompt, /## 总结格式|总结卡/)
  assert.doesNotMatch(chat.prompt, /面板会把它显示/)
  assert.match(chat.prompt, /写在回复里/)
  // CLI 定义写了 todos（Claude Code、Codex）的才说面板会显示
  assert.match(chatModePart(true), /面板会把它显示/)
  assert.doesNotMatch(
    chat.prompt,
    /## 授权情况|ask_push|项目对话|start_plan|start_workflow|create_conversation|## 执行方式|## 执行计划/,
  )
  // 项目里的对话照旧：授权、执行方式、面板计划都在，ask_push 和派子任务也在
  const conv = await run('p')
  assert.match(conv.prompt, /## 授权情况[\s\S]*ask_push/)
  assert.match(conv.prompt, /## 执行方式/)
  assert.ok(['set_plan', 'ask_push', 'spawn_agents', 'get_status'].every((n) => conv.names.includes(n)))
})

// 审计发现：wait_agents 每 50 秒返回一次让模型再调，每调一次把做完的结果全部重交（12 个子任务约 21 万字）
const wAgent = (id: string, name: string) => ({ ...AgentInput.parse({ name }), id, createdAt: '', updatedAt: '' })
const wAgents = [wAgent('w', '开发'), wAgent('q', '测试')]
const wakeWf = () =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: 'x',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'a', title: '实现', agentId: 'w', instructions: '写' },
          { id: 'b', title: '测试', agentId: 'q', instructions: '测' },
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
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('wait_agents：一直等到做完；有人传话时提前返回且只列 id；CLI 断开时不算取走；取过的不再交', async () => {
  const w = wakeWf()
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做' } as never, w, '', 'tw'),
    flowRun: FlowRun.parse({ owner: 'p' }),
    id: 'tw',
  } as any
  let n = 0
  const log: string[] = []
  await runEngineTurn({
    task,
    agents: wAgents,
    workflows: [w],
    workflow: w,
    prompt: '做',
    changed: () => {},
    newId: () => `id${++n}`,
    runAgent: async (call: any) => {
      const o = call.orch!
      if (call.step?.slot === 'sub') {
        await nap(call.step.title === '慢' ? 1500 : 100)
        return { ok: true, text: `${call.step.title}的结论` }
      }
      if (call.step?.id === 'a') {
        await callOrchTool(o, 'spawn_agents', {
          tasks: [
            { title: '快', instructions: 'x' },
            { title: '慢', instructions: 'x' },
          ],
        })
        // CLI 断开：不算取走
        const ac = new AbortController()
        ac.abort()
        log.push('aborted:' + text(await callOrchTool(o, 'wait_agents', {}, ac.signal)))
        const t0 = Date.now()
        const first = text(await callOrchTool(o, 'wait_agents', {}))
        log.push(`first(${Date.now() - t0}ms):` + first)
        const t1 = Date.now()
        const second = text(await callOrchTool(o, 'wait_agents', {}))
        log.push(`second(${Date.now() - t1}ms):` + second)
        log.push('third:' + text(await callOrchTool(o, 'wait_agents', {})))
        return { ok: true, text: 'ok' }
      }
      await nap(300)
      await callOrchTool(o, 'send_message', { to: '实现', text: '接口改名了' })
      return { ok: true, text: 'ok' }
    },
  } as any)
  assert.match(log[1], /做完 1 个[\s\S]*快的结论[\s\S]*还在执行：a\/sub\/\S+\n/)
  assert.doesNotMatch(log[1], /慢的结论/)
  assert.match(log[2], /做完 1 个[\s\S]*慢的结论/)
  assert.doesNotMatch(log[2], /快的结论/, '取过的不再交')
  assert.match(log[3], /都已经交回过了/)
})

test('create_conversation 的 edits：说明要改代码时交给面板，开工前先开好独立分支', async () => {
  const { callOrchTool } = await import('./orch-mcp.ts')
  const got: unknown[] = []
  const o = {
    createConversation: async (...args: unknown[]) => {
      got.push(args[4])
      return { ok: true, id: 'c1', info: '已新建' }
    },
  } as never
  await callOrchTool(o, 'create_conversation', { title: '改', message: '改个按钮', kind: 'task', edits: true })
  await callOrchTool(o, 'create_conversation', { title: '查', message: '查个问题', kind: 'task' })
  assert.equal((got[0] as { edits?: boolean }).edits, true)
  assert.equal((got[1] as { edits?: boolean }).edits, undefined, '只调研的不开')
  const tools = orchTools({
    self: 'a',
    coordinator: true,
    plans: false,
    canSpawn: true,
    common: [],
  } as never)
  const props = (
    tools.find((x) => x.name === 'create_conversation')!.inputSchema as { properties: Record<string, unknown> }
  ).properties
  assert.ok(props.edits, '模型看得到这个参数')
})
