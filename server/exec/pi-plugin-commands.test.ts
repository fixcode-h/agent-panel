import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandsQuery } from '../../shared/cli-commands-query.ts'
import { RpcSpec } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { parseQueried } from '../cli-commands.ts'
import { parserFor } from './parsers.ts'
import { createRpcSession } from './rpc/session.ts'
import { createSpecAdapter } from './rpc/spec.ts'

/** ADR 0050 第四期：Pi 插件带的「/」命令。get_commands 问出来的进菜单；插件命令原样交给 Pi，它自己处理完不开新一轮时这一轮照样结束 */

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms))

test('get_commands 的结果：插件命令原样交给 Pi，模板和 Skill 带文件路径由面板展开（Skill 去掉 skill: 前缀），没路径的模板不要', () => {
  const q = CommandsQuery.parse(getCli('pi')!.rpc!.commandsQuery)
  const got = parseQueried(q, {
    type: 'response',
    data: {
      commands: [
        { name: 'review', description: '审查改动', source: 'extension', sourceInfo: { path: '/p/ext.ts' } },
        { name: 'fix-tests', description: '修测试', source: 'prompt', sourceInfo: { path: '/p/prompts/fix-tests.md' } },
        { name: 'skill:lint', description: '检查', source: 'skill', sourceInfo: { path: '/p/skills/lint/SKILL.md' } },
        { name: 'nopath', source: 'prompt', sourceInfo: {} },
        { name: 'weird', source: 'theme' },
      ],
    },
  })
  assert.deepEqual(
    got.map((c) => [c.name, c.kind, !!c.native, c.path]),
    [
      ['review', 'command', true, '/p/ext.ts'],
      ['fix-tests', 'command', false, '/p/prompts/fix-tests.md'],
      ['lint', 'skill', false, '/p/skills/lint/SKILL.md'],
    ],
  )
  assert.deepEqual(parseQueried(q, {}), [])
})

/** 按 pi.json 的 rpc 建会话；等「已处理」的时间缩短，测试不用等 3 秒 */
function session() {
  const spec = RpcSpec.parse(getCli('pi')!.rpc)
  spec.handled = { ...spec.handled!, graceMs: 30 }
  const sent: any[] = []
  const rpc = createRpcSession({
    adapter: createSpecAdapter(spec, { parser: parserFor('pi', process.cwd()), cwd: process.cwd(), input: '/review' }),
    cwd: process.cwd(),
    input: '/review',
    onEvent: () => {},
  })
  rpc.start({ write: (line) => sent.push(JSON.parse(line)), end: () => {} })
  const reply = (command: string, data: object) =>
    rpc.handle({
      type: 'response',
      command,
      id: sent.filter((x) => x.type === command).at(-1)?.id,
      success: true,
      data,
    })
  // 结束时面板会再查会话统计、分叉点（可选），回掉它们才交结果
  const after = async () => {
    await wait()
    reply('get_session_stats', {})
    await wait()
    reply('get_fork_messages', { messages: [] })
    await wait()
  }
  const begin = async (disposition: string, before?: () => void) => {
    await wait()
    reply('get_state', { sessionId: 's1' })
    await wait()
    reply('get_fork_messages', { messages: [] })
    await wait()
    before?.()
    reply('prompt', { disposition })
    await wait()
  }
  return { rpc, begin, after }
}

test('插件命令被 Pi 自己处理掉（handled）、没开新一轮：等一会儿就结束这一轮；命令自己开了一轮（开始记录先到也算）就等它跑完', async () => {
  const a = session()
  await a.begin('handled')
  assert.ok(!a.rpc.finished)
  await wait(60)
  await a.after()
  assert.equal(a.rpc.finished, true, '没开新一轮：这一轮结束，不一直等')

  const b = session()
  await b.begin('handled', () => b.rpc.handle({ type: 'agent_start' }))
  await wait(60)
  assert.ok(!b.rpc.finished, '命令自己开了一轮：等它的结束记录')
  b.rpc.handle({ type: 'agent_settled', aborted: false })
  await b.after()
  assert.equal(b.rpc.finished, true)

  const c = session()
  await c.begin('started')
  await wait(60)
  assert.ok(!c.rpc.finished, '普通的一句照常等结束记录')
})
