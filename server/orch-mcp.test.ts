import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost, type Orchestra } from '../shared/engine.ts'
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
