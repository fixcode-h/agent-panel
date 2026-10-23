import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { RpcSpec } from '../../shared/cli-spec.ts'
import { getCli, type BuildOptions } from '../../shared/clis.ts'
import { t } from '../../shared/i18n.ts'
import { parserFor, type CliEvent } from './parsers.ts'
import { createRpcSession, type RpcDiagnose } from './rpc/session.ts'
import { createSpecAdapter } from './rpc/spec.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 按 shared/clis/pi.json 里的 rpc 配置建一条会话：命令、事件和结束条件都在配置里 */
async function session(
  input: string,
  op?: BuildOptions['op'],
  more: { resume?: string; forkBefore?: string; maxTurns?: number } = {},
  rpcOptions: { requestTimeoutMs?: number; diagnose?: RpcDiagnose } = {},
) {
  const def = getCli('pi')!
  const spec = RpcSpec.parse(def.rpc)
  const events: CliEvent[] = []
  const sent: any[] = []
  let ended = false
  const rpc = createRpcSession({
    adapter: createSpecAdapter(spec, {
      parser: parserFor('pi', process.cwd()),
      cwd: process.cwd(),
      input,
      op,
      ...more,
      fork: !!more.forkBefore,
    }),
    cwd: process.cwd(),
    input,
    onEvent: (e) => events.push(e),
    ...rpcOptions,
  })
  rpc.start({ write: (line) => sent.push(JSON.parse(line)), end: () => (ended = true) })
  await tick()
  return { rpc, events, sent, ended: () => ended }
}

/** 一轮结束后面板会再查一次会话统计（可选）：测试里回一下，不用等它超时 */
async function settle(
  rpc: Awaited<ReturnType<typeof session>>['rpc'],
  sent: any[],
  aborted = false,
  data: object = {},
) {
  rpc.handle({ type: 'agent_settled', aborted })
  await tick()
  rpc.handle(reply(sent, 'get_session_stats', data))
  await tick()
  rpc.handle(lastReply(sent, 'get_fork_messages', { messages: [] }))
  await tick()
}

/** 同一种请求发了几次时，回最后一次 */
const lastReply = (sent: any[], command: string, data: object) => ({
  type: 'response',
  command,
  id: sent.filter((x) => x.type === command).at(-1)?.id,
  success: true,
  data,
})

const reply = (sent: any[], command: string, data: object) => ({
  type: 'response',
  command,
  id: sent.find((x) => x.type === command)?.id,
  success: true,
  data,
})

test('Pi RPC：配置驱动，get_state 拿会话、prompt 开始、agent_settled 结束', async () => {
  const { rpc, events, sent, ended } = await session('用 Pi')
  assert.equal(sent[0].type, 'get_state')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-1' }))
  await tick()
  assert.equal(sent[1].type, 'get_fork_messages', '先记下开始前有几条用户消息')
  rpc.handle(reply(sent, 'get_fork_messages', { messages: [] }))
  await tick()
  assert.equal(sent[2].type, 'prompt')
  assert.equal(sent[2].message, '用 Pi')
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  assert.ok(events.some((e) => e.type === 'session' && e.id === 'pi-1'))

  rpc.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '这是 pi 的回复' } })
  rpc.handle({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      model: 'pi-fake',
      usage: { input: 4000, output: 100, totalTokens: 4100 },
    },
  })
  rpc.handle({ type: 'agent_end', messages: [] })
  assert.ok(!rpc.finished, 'agent_end 之后可能还有重试、压缩或插话，不能这时候结束')
  rpc.handle({ type: 'agent_settled', aborted: false })
  await tick()
  assert.ok(!rpc.finished, '结束前先查一次会话统计')
  assert.ok(sent.some((x) => x.type === 'get_session_stats'))
  rpc.handle(reply(sent, 'get_session_stats', { contextUsage: { tokens: 4321, contextWindow: 200000, percent: 2 } }))
  await tick()
  rpc.handle(lastReply(sent, 'get_fork_messages', { messages: [{ entryId: 'u1' }] }))
  await tick()
  assert.equal(rpc.finished, true)
  assert.ok(events.some((e) => e.type === 'turn' && e.id === 'u1'))
  assert.ok(events.some((e) => e.type === 'usage' && e.context === 4321 && e.window === 200000))
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === '这是 pi 的回复'))
  assert.ok(events.some((e) => e.type === 'usage' && e.addInput === 4000 && e.addOutput === 100))
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: true, error: undefined }],
  )
  assert.equal(ended(), true, '结束后关 stdin 让 Pi 退出')
})

test('Pi RPC：最后一条 assistant 报错时结果是失败', async () => {
  const { rpc, events, sent } = await session('FAIL')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-2' }))
  await tick()
  rpc.handle(reply(sent, 'get_fork_messages', { messages: [] }))
  await tick()
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  rpc.handle({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: '模拟的失败' },
  })
  await settle(rpc, sent)
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: false, error: '模拟的失败' }],
  )
})

test('Pi RPC：用户中断后 aborted 为真，按失败结束', async () => {
  const { rpc, events, sent } = await session('慢慢做')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-3' }))
  await tick()
  rpc.handle(reply(sent, 'get_fork_messages', { messages: [] }))
  await tick()
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  assert.equal(rpc.interrupt(), true)
  await tick()
  assert.ok(
    sent.some((x) => x.type === 'abort'),
    '中断发配置里的 abort',
  )
  await settle(rpc, sent, true)
  assert.ok(events.some((e) => e.type === 'result' && !e.ok))
})

test('Pi RPC：查会话统计失败也照常结束', async () => {
  const { rpc, events, sent } = await session('做完')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-4' }))
  await tick()
  rpc.handle(reply(sent, 'get_fork_messages', { messages: [] }))
  await tick()
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  rpc.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  rpc.handle({ type: 'agent_settled', aborted: false })
  await tick()
  const id = sent.find((x) => x.type === 'get_session_stats')?.id
  rpc.handle({ type: 'response', command: 'get_session_stats', id, success: false, error: '没有会话' })
  await tick()
  const fm = sent.filter((x) => x.type === 'get_fork_messages').at(-1)?.id
  rpc.handle({ type: 'response', command: 'get_fork_messages', id: fm, success: false, error: '没有会话' })
  await tick()
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: true, error: undefined }],
  )
})

test('Pi RPC：压缩走协议的 compact，压缩前后的大小来自 compaction_end', async () => {
  const { rpc, events, sent } = await session('', { kind: 'compact' })
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-5' }))
  await tick()
  assert.equal(sent[1].type, 'compact', '不发 prompt')
  assert.ok(!sent.some((x) => x.type === 'prompt'))
  rpc.handle({ type: 'compaction_start', reason: 'manual' })
  rpc.handle({
    type: 'compaction_end',
    reason: 'manual',
    result: { summary: '摘要', tokensBefore: 150000, estimatedTokensAfter: 32000 },
    aborted: false,
    willRetry: false,
  })
  rpc.handle(reply(sent, 'compact', { tokensBefore: 150000, estimatedTokensAfter: 32000 }))
  await tick()
  assert.ok(events.some((e) => e.type === 'compacted' && e.before === 150000 && e.context === 32000))
  assert.ok(events.some((e) => e.type === 'session' && e.id === 'pi-5'))
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: true, error: undefined }],
  )
})

test('Pi RPC：压缩失败时报 Pi 给的原因', async () => {
  const { rpc, events, sent } = await session('', { kind: 'compact' })
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-6' }))
  await tick()
  rpc.handle({ type: 'compaction_end', reason: 'manual', aborted: false, errorMessage: '没有可以压缩的内容' })
  const id = sent.find((x) => x.type === 'compact')?.id
  rpc.handle({ type: 'response', command: 'compact', id, success: false, error: '没有可以压缩的内容' })
  await tick()
  assert.ok(events.some((e) => e.type === 'notice' && e.failed && e.text.includes('没有可以压缩的内容')))
  assert.ok(!events.some((e) => e.type === 'compacted'), '没有压缩前后的大小，不算压缩过')
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: false, error: '没有可以压缩的内容' }],
  )
})

test('Pi RPC：自动重试显示在回复里，不当成失败', async () => {
  const { rpc, events, sent } = await session('重试')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-7' }))
  await tick()
  rpc.handle(reply(sent, 'get_fork_messages', { messages: [] }))
  await tick()
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  rpc.handle({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' })
  rpc.handle({ type: 'auto_retry_end', success: true, attempt: 2 })
  rpc.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  await settle(rpc, sent)
  const notices = events.filter((e) => e.type === 'notice')
  assert.equal(notices.length, 1, '重试成功不再提示')
  assert.ok(notices[0].type === 'notice' && !notices[0].failed && notices[0].text.includes('529 overloaded'))
  assert.ok(!events.some((e) => e.type === 'error'))
  assert.ok(events.some((e) => e.type === 'result' && e.ok))
})

test('Pi RPC：扩展的确认框交给页面，回答按 extension_ui_response 回给 Pi', async () => {
  const { rpc, events, sent } = await session('删文件')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-8' }))
  await tick()
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  rpc.handle({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'confirm',
    title: '执行危险命令？',
    message: 'rm -rf dist',
  })
  rpc.handle({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: '选一个', options: ['甲', '乙'] })
  rpc.handle({ type: 'extension_ui_request', id: 'ui-3', method: 'notify', message: '已拦下', notifyType: 'warning' })
  rpc.handle({ type: 'extension_ui_request', id: 'ui-4', method: 'setStatus', statusKey: 'x', statusText: '…' })
  const asks = events.filter((e) => e.type === 'ask')
  assert.equal(asks.length, 2)
  const [confirm, select] = asks as Extract<CliEvent, { type: 'ask' }>[]
  assert.equal(confirm.kind, 'tool')
  assert.equal(confirm.title, '执行危险命令？')
  assert.equal(confirm.detail, 'rm -rf dist')
  assert.deepEqual(select.options, ['甲', '乙'])
  confirm.reply({ allow: true })
  select.reply({ allow: true, answer: '乙' })
  assert.deepEqual(sent.at(-2), { type: 'extension_ui_response', id: 'ui-1', confirmed: true })
  assert.deepEqual(sent.at(-1), { type: 'extension_ui_response', id: 'ui-2', value: '乙' })
  // 通知显示成一行提示；状态栏这类不用回答、面板也不显示的直接忽略
  assert.ok(events.some((e) => e.type === 'notice' && e.text === '已拦下' && !e.failed))
})

test('Pi RPC：每轮记下这一轮用户消息的 entryId，插话的不算', async () => {
  const { rpc, events, sent } = await session('第二轮')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-9' }))
  await tick()
  rpc.handle(reply(sent, 'get_fork_messages', { messages: [{ entryId: 'u1', text: '第一轮' }] }))
  await tick()
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  rpc.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  rpc.handle({ type: 'agent_settled', aborted: false })
  await tick()
  rpc.handle(reply(sent, 'get_session_stats', {}))
  await tick()
  const post = sent.filter((x) => x.type === 'get_fork_messages').at(-1)
  rpc.handle({
    type: 'response',
    command: 'get_fork_messages',
    id: post.id,
    success: true,
    data: { messages: [{ entryId: 'u1' }, { entryId: 'u2' }, { entryId: 'u3-插话' }] },
  })
  await tick()
  assert.ok(events.some((e) => e.type === 'turn' && e.id === 'u2'))
  assert.ok(!events.some((e) => e.type === 'turn' && e.id === 'u3-插话'))
})

test('Pi RPC：分叉到某一轮之前先发 fork，再取新会话的 id', async () => {
  const { rpc, events, sent } = await session('换个做法', undefined, { resume: 'pi-old', forkBefore: 'u2' })
  assert.deepEqual({ type: sent[0].type, entryId: sent[0].entryId }, { type: 'fork', entryId: 'u2' })
  rpc.handle(reply(sent, 'fork', { text: '', cancelled: false }))
  await tick()
  assert.equal(sent[1].type, 'get_state')
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-new' }))
  await tick()
  assert.ok(events.some((e) => e.type === 'session' && e.id === 'pi-new'))
})

test('Pi RPC：Pi 没有回合上限参数，面板数 turn_start，超过就 abort，这一轮算失败', async () => {
  const { rpc, events, sent } = await session('一直改', undefined, { maxTurns: 2 })
  rpc.handle(reply(sent, 'get_state', { sessionId: 'pi-t' }))
  await tick()
  rpc.handle(reply(sent, 'get_fork_messages', { messages: [] }))
  await tick()
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  rpc.handle({ type: 'turn_start' })
  rpc.handle({ type: 'turn_start' })
  await tick()
  assert.ok(!sent.some((x) => x.type === 'abort'), '没超过时不打断')
  rpc.handle({ type: 'turn_start' })
  await tick()
  assert.ok(
    sent.some((x) => x.type === 'abort'),
    '第三回合开始时打断',
  )
  await settle(rpc, sent, true)
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: false, error: '达到回合上限（2），停止这一轮' }],
  )
})

/** 开好一轮，停在 Pi 正在执行的时候 */
async function running(input: string) {
  const s = await session(input)
  s.rpc.handle(reply(s.sent, 'get_state', { sessionId: 'pi-r' }))
  await tick()
  s.rpc.handle(reply(s.sent, 'get_fork_messages', { messages: [] }))
  await tick()
  s.rpc.handle(reply(s.sent, 'prompt', { disposition: 'started' }))
  await tick()
  return s
}

test('Pi RPC：插话被长命令挡着时，收回插话、abort，停下的结束不算结束，再把插话作为新的一句交给 Pi', async () => {
  const { rpc, events, sent } = await running('等 CI')
  const steered = rpc.steer('推送远端')
  await tick()
  rpc.handle(reply(sent, 'steer', { disposition: 'queued' }))
  assert.equal(await steered, true)
  const p = rpc.redirect('（说明）')
  await tick()
  assert.equal(sent.at(-1).type, 'clear_queue', '先收回还排着的插话')
  rpc.handle(reply(sent, 'clear_queue', { steering: ['推送远端'], followUp: [] }))
  await tick()
  assert.equal(sent.at(-1).type, 'abort')
  // Pi 的 abort 等这一轮停下才回：结束记录先到
  rpc.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } })
  rpc.handle({ type: 'agent_settled', aborted: true })
  await tick()
  assert.ok(!rpc.finished, '为插话停下的不算这一轮结束')
  rpc.handle(reply(sent, 'abort', {}))
  await tick()
  assert.ok(
    events.some((e) => e.type === 'notice'),
    '标出停下了命令',
  )
  const prompt = sent.at(-1)
  assert.deepEqual({ type: prompt.type, message: prompt.message }, { type: 'prompt', message: '（说明）\n\n推送远端' })
  rpc.handle(lastReply(sent, 'prompt', { disposition: 'started' }))
  assert.equal(await p, true)
  rpc.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  await settle(rpc, sent)
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: true, error: undefined }],
  )
})

test('Pi RPC：插话已经被取走（命令刚好跑完）就不打断', async () => {
  const { rpc, sent } = await running('等 CI')
  const p = rpc.redirect('（说明）')
  await tick()
  rpc.handle(reply(sent, 'clear_queue', { steering: [], followUp: [] }))
  assert.equal(await p, false)
  assert.ok(!sent.some((x) => x.type === 'abort'))
})

const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 超时后交回来的结果文案 */
function failedError(events: CliEvent[]): string {
  const result = events.find((e) => e.type === 'result') as Extract<CliEvent, { type: 'result' }> | undefined
  assert.ok(result, '超时要交一个结果')
  assert.equal(result.ok, false)
  return result.error ?? ''
}

test('Pi RPC：请求超时时，错误里带等待秒数、进程状态和 stderr', async () => {
  const { events, sent } = await session(
    '慢',
    undefined,
    {},
    {
      requestTimeoutMs: 1000,
      diagnose: { alive: () => true, stderr: () => 'warning: 模型列表没取到\nError: 接口 502' },
    },
  )
  assert.equal(sent[0].type, 'get_state')
  await waitMs(1200)
  const message = failedError(events)
  assert.ok(
    message.startsWith(t('{method} 没有响应（已等 {seconds} 秒）', { method: 'get_state', seconds: 1 })),
    `带上等了多少秒：${message}`,
  )
  assert.ok(message.includes(t('进程还在运行')), `带上进程状态：${message}`)
  assert.ok(message.includes(t('stderr 最后几行：')), `带上 stderr 尾巴：${message}`)
  assert.ok(message.includes('Error: 接口 502'), message)
})

test('Pi RPC：进程已经退出时，错误里带上 stderr 最后几行', async () => {
  const { events } = await session(
    '崩了',
    undefined,
    {},
    {
      requestTimeoutMs: 1000,
      diagnose: { alive: () => false, stderr: () => 'line1\nline2\nline3\nline4' },
    },
  )
  await waitMs(1200)
  const message = failedError(events)
  assert.ok(message.includes(t('进程已经退出')), `用户能看出进程不在了：${message}`)
  assert.ok(message.includes('line4'), `带上 stderr：${message}`)
  assert.ok(!message.includes('line1'), `只带最后三行：${message}`)
})

test('Pi 桥接扩展：面板 MCP 端点不回时，初始化超时后照常加载，不再把 Pi 卡在启动阶段', async () => {
  const def = getCli('pi')!
  const template = String(def.mcp!.files['{dir}/agent-panel-{name}.ts'])
  // 只收请求、不回应：复现面板 MCP 端点卡住
  const server = createServer(() => {})
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const dir = mkdtempSync(join(tmpdir(), 'pi-ext-'))
  const file = join(dir, 'agent-panel-test.ts')
  writeFileSync(file, template.replaceAll('{name}', 'panel').replaceAll('{url}', `http://127.0.0.1:${port}/mcp`))
  const statuses: string[] = []
  let onSessionStart: ((event: unknown, ctx: any) => void) | undefined
  const pi = {
    on: (_name: string, cb: (event: unknown, ctx: any) => void) => (onSessionStart = cb),
    registerTool: () => {},
  }
  const startedAt = Date.now()
  try {
    const mod = await import(pathToFileURL(file).href)
    await mod.default(pi)
  } finally {
    server.closeAllConnections?.()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  const waited = Date.now() - startedAt
  assert.ok(waited >= 2900, `等满超时才放行：${waited}ms`)
  assert.ok(waited < 10_000, `不会一直等下去：${waited}ms`)
  // 超时要让面板知道原因（界面显示成一行错误），而不是只剩模型说「没有面板的工具」
  onSessionStart?.({}, { ui: { setStatus: (key: string, text: string) => statuses.push(`${key}=${text}`) } })
  assert.ok(statuses[0]?.includes('3 秒还没回应'), `报出超时的原因：${statuses[0]}`)
})
