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
  } as Task
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
      if (call.step?.slot === 'sub') return { ok: true, text: '页面查好了' }
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
  assert.match(text(await callOrchTool(orch!, 'wait_agents', {})), /做完 1 个/)
  // 对话这一轮结束后停下等子任务，结果交回同一个会话接着做；对话里记成面板消息，不是用户消息
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /页面查好了/)
  const back = task.messages.find((m) => m.panel === 'helpers')
  assert.equal(back?.role, 'system')
  assert.match(back!.text, /### 页面/)
  assert.equal(task.status, 'done')
})
