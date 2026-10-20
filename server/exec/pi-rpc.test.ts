import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcSpec } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { parserFor, type CliEvent } from './parsers.ts'
import { createRpcSession } from './rpc/session.ts'
import { createSpecAdapter } from './rpc/spec.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 按 shared/clis/pi.json 里的 rpc 配置建一条会话：命令、事件和结束条件都在配置里 */
async function session(input: string) {
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
    }),
    cwd: process.cwd(),
    input,
    onEvent: (e) => events.push(e),
  })
  rpc.start({ write: (line) => sent.push(JSON.parse(line)), end: () => (ended = true) })
  await tick()
  return { rpc, events, sent, ended: () => ended }
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
  assert.equal(rpc.finished, true)
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
  rpc.handle({ type: 'agent_settled', aborted: false })
  await tick()
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
  rpc.handle({ type: 'agent_settled', aborted: true })
  await tick()
  assert.ok(events.some((e) => e.type === 'result' && !e.ok))
})
