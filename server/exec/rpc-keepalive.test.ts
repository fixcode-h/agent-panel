import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcSpec } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { commandCodeParser, type CliEvent } from './parsers.ts'
import { createRpcSession } from './rpc/session.ts'
import { createSpecAdapter } from './rpc/spec.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 建一条带保活的会话：hold 决定这一轮结束后留不留进程，next 由测试控制什么时候给下一句 */
function session(o: { hold: boolean; input?: string; next?: () => Promise<string | null> }) {
  const def = getCli('commandcode')!
  const spec = RpcSpec.parse(def.rpc)
  const events: CliEvent[] = []
  const sent: any[] = []
  let ended = false
  const rpc = createRpcSession({
    adapter: createSpecAdapter(spec, {
      parser: commandCodeParser(process.cwd()),
      cwd: process.cwd(),
      input: o.input ?? '先看代码',
      maxTurns: 50,
    }),
    cwd: process.cwd(),
    input: o.input ?? '先看代码',
    onEvent: (e) => events.push(e),
    hold: () => o.hold,
    next: o.next,
  })
  rpc.start({ write: (line) => sent.push(JSON.parse(line)), end: () => (ended = true) })
  return { rpc, events, sent, ended: () => ended }
}

/** 走完一次握手和一轮的结尾 */
async function turnDone(s: ReturnType<typeof session>, turnId = 't1') {
  s.rpc.handle({ jsonrpc: '2.0', id: 1, result: { session: { id: 's1' } } })
  await tick()
  s.rpc.handle({ jsonrpc: '2.0', id: 2, result: { turnId } })
  await tick()
  s.rpc.handle({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId, stopReason: 'end_turn' } })
  await tick()
}

test('保活：模型没调 wait_user_message，回复完进程也留着等下一句', async () => {
  let deliver: (v: string | null) => void = () => {}
  const next = () => new Promise<string | null>((r) => (deliver = r))
  const s = session({ hold: true, next })
  await turnDone(s)

  // 这一轮结束：发了结果，但没有 session/exit、也没有关 stdin
  assert.ok(s.events.some((e) => e.type === 'result' && e.ok))
  assert.equal(s.ended(), false, '进程留着')
  assert.equal(s.rpc.waiting, true, '在等用户下一句')
  assert.ok(!s.sent.some((x) => x.method === 'session/exit'), '还没退出会话')

  // 用户发来下一句：同一进程里开下一轮，不重启 CLI
  deliver('接着看看测试')
  await tick()
  await tick()
  const start = s.sent.filter((x) => x.method === 'turn/start').at(-1)
  assert.equal(start.params.input, '接着看看测试', '下一句直接交给同一个进程')
  assert.equal(s.rpc.finished, false, '又进入了一轮')
  assert.equal(s.rpc.waiting, false)
})

test('保活：用户离开（返回 null）或 CLI 不支持（hold 为假）都按协议结束进程', async () => {
  // 用户离开：等到 null 就结束，不是一直挂着
  const left = session({ hold: true, next: async () => null })
  await turnDone(left)
  await tick()
  await tick()
  assert.equal(left.ended(), true, '关掉了 stdin')
  assert.ok(
    left.sent.some((x) => x.method === 'session/exit'),
    '按配置发 session/exit，会话记录完整',
  )

  // 不支持保活：这一轮结束就退出，一轮一个进程
  const noHold = session({ hold: false, next: async () => '不该用到' })
  await turnDone(noHold)
  await tick()
  assert.equal(noHold.ended(), true, '这一轮结束就退出')
  assert.ok(noHold.sent.some((x) => x.method === 'session/exit'))
})
