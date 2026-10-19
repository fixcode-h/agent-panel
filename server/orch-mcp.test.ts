import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost, type Orchestra } from '../shared/engine.ts'
import { callOrchTool, openOrchSession, orchHint, orchMcpApi } from './orch-mcp.ts'

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

/** 模拟 CLI：实现节点派两个子 Agent、问主 Agent、给测试节点传话；主 Agent 一律通过 */
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
      if (call.dispatching === 'evaluate') return { ok: true, text: '好。\n```dispatch\n{"action":"continue"}\n```' }
      if (call.dispatching === 'summary') return { ok: true, text: '最终：都好了' }
      if (call.dispatching === 'answer') return { ok: true, text: '用方案二' }
      const o = call.orch!
      if (call.step?.id === 'a') {
        const r = await callOrchTool(o, 'spawn_agents', {
          tasks: [
            { title: '接口', instructions: '写接口' },
            { title: '页面', instructions: '写页面', agent: '测试', tier: 'low' },
          ],
        })
        assert.match(text(r), /a\/sub\/h1、a\/sub\/h2/)
        const asked = text(await callOrchTool(o, 'ask_main', { question: '用哪个方案？' }))
        assert.match(asked, /用方案二/)
        assert.match(text(await callOrchTool(o, 'send_message', { to: '测试', text: '接口改名了' })), /测试/)
        const got = text(await callOrchTool(o, 'wait_agents', { seconds: 5 }))
        assert.match(got, /做完 2 个/)
        assert.match(got, /子 Agent「接口」做完了/)
        assert.match(text(await callOrchTool(o, 'get_status', {})), /- a\/sub\/h2｜子 Agent · 页面（测试）：完成/)
        return { ok: true, text: '实现好了' }
      }
      if (call.step?.slot === 'sub') {
        // 子 Agent 还能再派一层，再往下不行
        if (call.step.id === 'a/sub/h1') {
          await callOrchTool(o, 'spawn_agents', { tasks: [{ title: '更细', instructions: '拆得更细' }] })
          assert.match(text(await callOrchTool(o, 'wait_agents', {})), /做完 1 个/)
        }
        if (call.step.id === 'a/sub/h1/sub/h1')
          assert.match(
            text(await callOrchTool(o, 'spawn_agents', { tasks: [{ title: 'x', instructions: 'y' }] })),
            /两层/,
          )
        return { ok: true, text: `子 Agent「${call.step.title}」做完了` }
      }
      // 测试节点晚一点开始读消息：实现节点传的话要在
      await new Promise((r) => setTimeout(r, 50))
      return { ok: true, text: `测试好了：${text(await callOrchTool(o, 'read_messages', {}))}` }
    },
  }
}

test('编排工具：派子 Agent 并行、取结果、问主 Agent、传话，任务进度里是主 Agent → 节点 → 子 Agent 的层级', async () => {
  const w = workflow()
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't1'),
    id: 't1',
  } as Task
  const log: AgentCall[] = []
  await runEngineTurn(host(task, log))
  assert.equal(task.status, 'done', JSON.stringify(task.messages.map((m) => m.text)))
  const by = (id: string) => task.steps.find((s) => s.id === id)!
  assert.equal(by('@main').status, 'done')
  assert.equal(by('@main').output, '最终：都好了')
  assert.equal(by('a/sub/h1').parentId, 'a')
  assert.equal(by('a/sub/h1/sub/h1').status, 'done', '子 Agent 再派的一层')
  assert.equal(by('a/sub/h2').agentId, 'q', '按名字交给指定的 Agent')
  assert.equal(log.find((c) => c.step?.id === 'a/sub/h2')?.tier, 'low')
  assert.match(by('b').output, /来自「实现」的消息：接口改名了/, '传话进了对方的收件箱')
  // 主 Agent：两个节点各评估一次、回答一次提问、最后整理一次
  assert.equal(log.filter((c) => c.dispatching).length, 4)
  assert.ok(log.filter((c) => c.dispatching).every((c) => c.sessionKey === '@main'))
  assert.ok(task.messages.some((m) => m.step === 'a' && /派出 2 个子 Agent/.test(m.text)))
})

test('编排工具的 MCP：列出工具、调用、结束后失效', async () => {
  const w = workflow()
  const task = { ...newTask({ projectId: 'p', mode: 'workflow', prompt: 'x' } as never, w, '', 't2'), id: 't2' } as Task
  const log: AgentCall[] = []
  let orch: AgentCall['orch']
  const h = host(task, log)
  h.runAgent = async (call) => {
    if (call.step?.id === 'a') orch = call.orch
    return call.dispatching === 'evaluate'
      ? { ok: true, text: '```dispatch\n{"action":"continue"}\n```' }
      : { ok: true, text: 'ok' }
  }
  await runEngineTurn(h)
  const s = openOrchSession(orch!)
  const app = orchMcpApi()
  const path = new URL(s.url).pathname.replace('/api/mcp', '')
  const post = (body: unknown) =>
    app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const list = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
  const names = list.result.tools.map((x: { name: string }) => x.name)
  assert.deepEqual(names, ['get_status', 'spawn_agents', 'wait_agents', 'ask_main', 'send_message', 'read_messages'])
  const st = await (
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } })
  ).json()
  assert.match(st.result.content[0].text, /- @main｜主 Agent（主管）：完成/)
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
  const s = openOrchSession(o)
  const path = new URL(s.url).pathname.replace('/api/mcp', '')
  const res = await orchMcpApi().request(path, {
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
