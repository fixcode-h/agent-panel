import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { RpcSpec } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { runProcess } from './process.ts'
import { commandCodeParser, type CliEvent } from './parsers.ts'
import { createRpcSession } from './rpc/session.ts'
import { createSpecAdapter } from './rpc/spec.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeCli = path.join(here, '../../scripts/fake-cli/fake-cli.mjs')

/**
 * 用真的子进程跑一遍保活：Command Code 的 RPC 协议 + 假 CLI。
 * 第一轮结束后进程不能退出，第二句要在同一个进程里开下一轮。
 */
test('保活：真进程里一轮结束后不退出，下一句在同一进程接着跑', async () => {
  const def = getCli('commandcode')!
  const spec = RpcSpec.parse(def.rpc)
  const events: CliEvent[] = []
  const results: boolean[] = []
  const turns: string[] = []
  let next: string | null = '第二句'
  let first = true
  let pid = 0

  const session = createRpcSession({
    adapter: createSpecAdapter(spec, {
      parser: commandCodeParser(process.cwd()),
      cwd: process.cwd(),
      input: '第一句',
      maxTurns: 10,
    }),
    cwd: process.cwd(),
    input: '第一句',
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'result') results.push(e.ok)
    },
    hold: () => true,
    next: async () => {
      // 第一轮结束后给第二句；第二句跑完返回 null，让进程正常退出
      if (first) {
        first = false
        return next
      }
      return null
    },
  })

  const run = runProcess({
    command: process.execPath,
    args: [fakeCli, '--experimental', '--rpc', '--trust', '--no-auto-update'],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 60_000,
    onSpawn: (io) => {
      pid = process.pid
      session.start(io)
    },
    onLine: (line) => {
      session.line(line)
      turns.push(line)
    },
  })

  const r = await run

  assert.equal(results.length, 2, '第一句和第二句各产生一次结果')
  assert.deepEqual(results, [true, true])
  const sessionIds = new Set(events.filter((e) => e.type === 'session').map((e) => (e as { id: string }).id))
  assert.equal(sessionIds.size, 1, `两轮用的是同一个会话（同一个进程）：${[...sessionIds].join(', ')}`)
  assert.ok(r.code === 0 || r.code === null, `进程正常退出：${r.code} ${r.stderr}`)
  assert.ok(pid > 0)
})
