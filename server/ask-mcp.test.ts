import assert from 'node:assert/strict'
import test from 'node:test'
import { askMcpApi, openAskBridge, toQuestions } from './ask-mcp.ts'
import type { Orchestra } from '../shared/engine.ts'

/** 直接调面板的 MCP 接口，返回这一条 JSON-RPC 的结果 */
async function rpc(token: string, msg: unknown) {
  const res = await askMcpApi().request(`/ask/${token}`, {
    method: 'POST',
    body: JSON.stringify(msg),
    headers: { 'content-type': 'application/json' },
  })
  // 服务端只带 Node 类型，Response.json() 是 unknown（DOM 里是 any）；测试按接口约定直接读字段，放宽成 any
  return res.json() as Promise<any>
}
const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!

test('模型传来的问题整理成面板的问题，也认只问一个的简单写法', () => {
  const q = toQuestions({
    questions: [
      { header: '方向', question: '做什么？', options: ['a', { label: 'b', description: 'x' }, {}], multiSelect: 1 },
    ],
  })
  assert.deepEqual(q[0].options, [
    { label: 'a', description: '' },
    { label: 'b', description: 'x' },
  ])
  assert.equal(q[0].multiSelect, true)
  assert.equal(toQuestions({ question: '单个问题', options: ['x'] })[0].question, '单个问题')
  assert.deepEqual(toQuestions({ questions: [{ header: '没有问题文字' }] }), [])
})

test('执行中补充的通道：挂上 read_user_notes 取走补充，取过的不再给；只挂提问时没有这个工具', async () => {
  // 还没取走的补充：取一次就交出去，之后说「没有新的补充」
  const pending = ['用户在执行中补充了信息，请结合它继续当前的任务：\n先别改配置']
  const s = openAskBridge({ notes: () => pending.splice(0) })
  const token = tokenOf(s.url)
  const list = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ['read_user_notes'],
  )
  const got = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_user_notes' } })
  assert.match(got.result.content[0].text, /先别改配置/)
  const again = await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_user_notes' } })
  assert.equal(again.result.content[0].text, '没有新的补充')
  s.close()

  // 只挂提问（CLI 有插话协议或配置里没有 notes）：没有取补充的工具
  const ask = openAskBridge({ ask: () => {} })
  const askToken = tokenOf(ask.url)
  const askList = await rpc(askToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(
    askList.result.tools.map((t: { name: string }) => t.name),
    ['ask_user'],
  )
  const noTool = await rpc(askToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'read_user_notes' },
  })
  assert.equal(noTool.result.isError, true)
  ask.close()
})

test('提问用 SSE 流一直挂着：等到用户回答才把结果写回去', async () => {
  let reply: ((r: { allow: boolean; answer?: string }) => void) | undefined
  const s = openAskBridge({ ask: (ev) => (reply = ev.reply) })
  const token = tokenOf(s.url)
  const res = await askMcpApi().request(`/ask/${token}`, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ask_user', arguments: { question: '做什么？' } },
    }),
    headers: { 'content-type': 'application/json' },
  })
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  let answered = false
  const body = res.text().then((text) => {
    answered = true
    return text
  })
  // 面板收到了问题，但用户还没回答：流不能结束
  for (let i = 0; i < 100 && !reply; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(reply, '面板把问题交给了用户')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(answered, false, '用户没回答时请求一直挂着')
  reply!({ allow: true, answer: '写文档' })
  const text = await body
  const data = text.split('\n').find((l) => l.startsWith('data:'))
  assert.match(data ?? '', /用户的回答/)
  assert.match(data ?? '', /写文档/)
  s.close()
})

test('等下一句：工具一直挂着，用户的消息作为工具结果交回；用户离开时结束', async () => {
  let deliver: ((text: string | null) => void) | undefined
  const s = openAskBridge({ wait: () => new Promise((resolve) => (deliver = resolve)) })
  const token = tokenOf(s.url)
  const list = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ['wait_user_message'],
  )
  const res = await askMcpApi().request(`/ask/${token}`, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'wait_user_message' },
    }),
    headers: { 'content-type': 'application/json' },
  })
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  let finished = false
  const body = res.text().then((text) => {
    finished = true
    return text
  })
  for (let i = 0; i < 100 && !deliver; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(deliver, '模型停在等下一句上')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(finished, false, '用户没发消息时请求一直挂着')
  deliver!('接着改配置')
  const text = await body
  assert.match(text, /接着改配置/)
  s.close()
})

test('等下一句：用户离开时返回明确的结束说明', async () => {
  const s = openAskBridge({ wait: async () => null })
  const token = tokenOf(s.url)
  const res = await askMcpApi().request(`/ask/${token}`, {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait_user_message' },
    }),
    headers: { 'content-type': 'application/json' },
  })
  assert.match(await res.text(), /用户已经离开了这个对话/)
  s.close()
})

test('握手告诉桥接扩展这一轮有没有编排工具：压缩轮、审查轮只挂提问工具时是 false', async () => {
  // 扩展靠这个标志决定要不要核对核心工具：没说清楚时它只能按服务名猜，压缩轮会被报成工具清单不完整
  const hello = (s: ReturnType<typeof openAskBridge>) =>
    rpc(tokenOf(s.url), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  const ask = openAskBridge({ ask: () => {} })
  assert.equal((await hello(ask)).result.capabilities.experimental.orchestration.enabled, false)
  ask.close()
  const orch = openAskBridge({ orch: { self: 'a', hasMain: false, common: [] } as unknown as Orchestra })
  assert.equal((await hello(orch)).result.capabilities.experimental.orchestration.enabled, true)
  orch.close()
})

test('执行中补充的通道：没有新补充时说清楚，通道关掉后失效', async () => {
  const s = openAskBridge({ notes: () => [] })
  const token = tokenOf(s.url)
  const r = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_user_notes' } })
  assert.equal(r.result.content[0].text, '没有新的补充')
  s.close()
  assert.equal((await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).error.code, -32001)
})
