import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcSpec } from '../../shared/cli-spec.ts'
import { getCli, type BuildOptions } from '../../shared/clis.ts'
import { parserFor, type CliEvent } from './parsers.ts'
import { createRpcSession } from './rpc/session.ts'
import { createSpecAdapter } from './rpc/spec.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 按 shared/clis/pi.json 里的 rpc 配置建一条会话：命令、事件和结束条件都在配置里 */
async function session(input: string, op?: BuildOptions['op']) {
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
    }),
    cwd: process.cwd(),
    input,
    onEvent: (e) => events.push(e),
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
}

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
  assert.equal(sent[1].type, 'prompt')
  assert.equal(sent[1].message, '用 Pi')
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
  assert.equal(rpc.finished, true)
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
  rpc.handle(reply(sent, 'prompt', { disposition: 'started' }))
  await tick()
  rpc.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  rpc.handle({ type: 'agent_settled', aborted: false })
  await tick()
  const id = sent.find((x) => x.type === 'get_session_stats')?.id
  rpc.handle({ type: 'response', command: 'get_session_stats', id, success: false, error: '没有会话' })
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
