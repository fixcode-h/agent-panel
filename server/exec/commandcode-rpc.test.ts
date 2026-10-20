import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcSpec } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { commandCodeParser, type CliEvent } from './parsers.ts'
import { createRpcSession } from './rpc/session.ts'
import { createSpecAdapter } from './rpc/spec.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 按 shared/clis/commandcode.json 里的 rpc 配置建一条会话，不写任何 Command Code 专用代码 */
function session(input: string, maxTurns?: number) {
  const def = getCli('commandcode')!
  const spec = RpcSpec.parse(def.rpc)
  const events: CliEvent[] = []
  const sent: any[] = []
  let ended = false
  const rpc = createRpcSession({
    adapter: createSpecAdapter(spec, {
      parser: commandCodeParser(process.cwd()),
      cwd: process.cwd(),
      input,
      maxTurns,
    }),
    cwd: process.cwd(),
    input,
    onEvent: (e) => events.push(e),
  })
  rpc.start({ write: (line) => sent.push(JSON.parse(line)), end: () => (ended = true) })
  return { rpc, events, sent, ended: () => ended }
}

test('Command Code 常驻 RPC：配置驱动，初始化、开始一轮、插话、结束', async () => {
  const { rpc, events, sent, ended } = session('先看代码', 50)
  assert.equal(sent[0].method, 'initialize')
  rpc.handle({ jsonrpc: '2.0', id: 1, result: { session: { id: 's1' } } })
  await tick()
  assert.equal(sent[1].method, 'turn/start')
  assert.equal(sent[1].params.input, '先看代码')
  assert.equal(sent[1].params.maxTurns, 50, '回合上限走 turn/start 的参数')
  rpc.handle({ jsonrpc: '2.0', id: 2, result: { turnId: 't1' } })
  await tick()
  assert.ok(events.some((e) => e.type === 'session' && e.id === 's1'))
  assert.ok(events.some((e) => e.type === 'turn' && e.id === 't1'))

  // 插话：CLI 回 result 才算交出去
  const steering = rpc.steer('顺便看看测试')
  await tick()
  const steer = sent.find((x) => x.method === 'turn/steer')
  assert.equal(steer.params.input, '顺便看看测试')
  rpc.handle({ jsonrpc: '2.0', id: steer.id, result: { turnId: 't1', queued: 1 } })
  assert.equal(await steering, true)

  // CLI 报错（这一轮刚结束）时不接：调用方会排进队列
  const late = rpc.steer('晚了一步')
  await tick()
  const lateReq = sent.filter((x) => x.method === 'turn/steer').at(-1)
  rpc.handle({ jsonrpc: '2.0', id: lateReq.id, error: { message: 'no active turn' } })
  assert.equal(await late, false)

  // 事件流沿用一次性执行的解析
  rpc.handle({ type: 'event', seq: 3, event: { type: 'text_delta', delta: '看完了' } })
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === '看完了'))

  rpc.handle({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { turnId: 't1', stopReason: 'end_turn' },
  })
  await tick()
  assert.ok(events.some((e) => e.type === 'result' && e.ok))
  assert.equal(rpc.finished, true)
  assert.ok(
    sent.some((x) => x.method === 'session/exit'),
    '结束后按配置发 session/exit',
  )
  assert.equal(ended(), true)
  assert.equal(await rpc.steer('已经结束了'), false)
})

test('Command Code 常驻 RPC：这一轮出错时结果带上原因', async () => {
  const { rpc, events, sent } = session('做点什么')
  rpc.handle({ jsonrpc: '2.0', id: 1, result: { session: { id: 's2' } } })
  await tick()
  rpc.handle({ jsonrpc: '2.0', id: 2, result: { turnId: 't2' } })
  await tick()
  rpc.handle({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { turnId: 't2', stopReason: 'run_error', error: { message: '网络断了' } },
  })
  await tick()
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: false, error: '网络断了' }],
  )
  assert.ok(sent.some((x) => x.method === 'session/exit'))
})
