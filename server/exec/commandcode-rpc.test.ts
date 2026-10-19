import assert from 'node:assert/strict'
import test from 'node:test'
import { commandCodeRpcSession } from './commandcode-rpc.ts'
import type { CliEvent } from './parsers.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

test('Command Code 常驻 RPC：初始化、开始一轮、插话、结束', async () => {
  const sent: any[] = []
  const events: CliEvent[] = []
  let ended = false
  const session = commandCodeRpcSession({ cwd: process.cwd(), input: '先看代码', onEvent: (e) => events.push(e) })
  const starting = session.start({ write: (line) => sent.push(JSON.parse(line)), end: () => (ended = true) })

  assert.equal(sent[0].method, 'initialize')
  session.line(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { session: { id: 's1' } } }))
  await tick()
  assert.equal(sent[1].method, 'turn/start')
  assert.equal(sent[1].params.input, '先看代码')
  session.line(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { turnId: 't1' } }))
  await starting
  assert.ok(events.some((e) => e.type === 'session' && e.id === 's1'))

  // 插话：CLI 回 result 才算交出去
  const steering = session.steer('顺便看看测试')
  await tick()
  const steer = sent.find((x) => x.method === 'turn/steer')
  assert.equal(steer.params.input, '顺便看看测试')
  session.line(JSON.stringify({ jsonrpc: '2.0', id: steer.id, result: { turnId: 't1', queued: 1 } }))
  assert.equal(await steering, true)

  // CLI 报错（这一轮刚结束）时不接：调用方会排进队列
  const late = session.steer('晚了一步')
  await tick()
  const lateReq = sent.filter((x) => x.method === 'turn/steer').at(-1)
  session.line(JSON.stringify({ jsonrpc: '2.0', id: lateReq.id, error: { message: 'no active turn' } }))
  assert.equal(await late, false)

  // 事件流沿用一次性执行的解析
  session.line(JSON.stringify({ type: 'event', seq: 3, event: { type: 'text_delta', delta: '看完了' } }))
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === '看完了'))

  session.line(
    JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId: 't1', stopReason: 'end_turn' } }),
  )
  await tick()
  assert.ok(events.some((e) => e.type === 'result' && e.ok))
  assert.equal(session.finished, true)
  assert.ok(sent.some((x) => x.method === 'session/exit'))
  assert.equal(ended, true)
  assert.equal(await session.steer('已经结束了'), false)
})

test('Command Code 常驻 RPC：这一轮出错时结果带上原因', async () => {
  const events: CliEvent[] = []
  const session = commandCodeRpcSession({ cwd: process.cwd(), input: '做点什么', onEvent: (e) => events.push(e) })
  const sent: any[] = []
  const starting = session.start({ write: (line) => sent.push(JSON.parse(line)), end: () => {} })
  session.line(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { session: { id: 's2' } } }))
  await tick()
  session.line(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { turnId: 't2' } }))
  await starting
  session.line(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turnId: 't2', stopReason: 'run_error', error: { message: '网络断了' } },
    }),
  )
  await tick()
  assert.deepEqual(
    events.filter((e) => e.type === 'result'),
    [{ type: 'result', ok: false, error: '网络断了' }],
  )
})
