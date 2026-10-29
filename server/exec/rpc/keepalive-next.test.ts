/**
 * 保活：对话页还开着时，Claude Code、Codex 回复完不关进程，下一条消息在同一个进程里开下一轮。
 * 这两个 CLI 的提问和审批走自己的协议（rpc.nativeAsk），和「进程能不能留着」无关；
 * 以前 canWait 把 nativeAsk 一起排除，配了 keepAlive 也没生效（见 runner.ts 的 canKeepAlive）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { getCli } from '../../../shared/clis.ts'
import { parserFor } from '../parsers.ts'
import { canKeepAlive } from '../runner.ts'
import { claudeAdapter, claudeContextSnapshot } from './claude.ts'
import { codexAdapter } from './codex.ts'
import { createRpcSession } from './session.ts'
import type { RpcAdapter } from './types.ts'

/** 会话引擎里很多步骤是 async 链，一次 tick 不够 */
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

/** 一条带保活的会话：记录发出去的消息，进程有没有被关掉 */
function session(adapter: RpcAdapter) {
  const sent: any[] = []
  const events: any[] = []
  let ended = false
  let deliver: (v: string | null) => void = () => {}
  const rpc = createRpcSession({
    adapter,
    cwd: process.cwd(),
    input: '第一句',
    onEvent: (e) => events.push(e),
    hold: () => true,
    next: () => new Promise<string | null>((r) => (deliver = r)),
  })
  rpc.start({ write: (s) => sent.push(JSON.parse(s)), end: () => (ended = true) })
  return { rpc, sent, events, ended: () => ended, deliver: (v: string) => deliver(v) }
}

/** 用户发来下一句：等会话把它交给同一个进程 */
async function next(s: ReturnType<typeof session>, text: string) {
  s.deliver(text)
  await flush()
}

test('保活判定：Claude Code、Codex 的对话能留进程，工作流、操作模式和没开 keepAlive 的 CLI 不行', () => {
  // clis.ts 里的内置 CLI 用顶层 keepAlive 字段（JSON 配置走 features.keepAlive，最终映射到同一个字段）
  for (const id of ['claude', 'codex'])
    assert.equal(
      canKeepAlive({ chat: true, op: false, cliKeepAlive: getCli(id)!.keepAlive }),
      true,
      `${id} 的对话要能保活`,
    )
  // 工作流节点、子任务不是对话（runner 的 chat）；压缩、审查这类操作也只是一次调用
  assert.equal(canKeepAlive({ chat: false, op: false, cliKeepAlive: true }), false, '工作流节点不保活')
  assert.equal(canKeepAlive({ chat: true, op: true, cliKeepAlive: true }), false, '压缩、审查这类操作不保活')
  assert.equal(canKeepAlive({ chat: true, op: false, cliKeepAlive: false }), false, '没开 keepAlive 的 CLI 不保活')
})

test('保活的下一轮：Claude Code、Codex 在同一个进程里按各自的协议开下一轮', async () => {
  // Claude Code：再写一条不带 priority 的 user 消息（priority 是执行中插话）
  const claude = session(
    claudeAdapter({ cwd: process.cwd(), input: '第一句', parse: parserFor('claude', process.cwd()) }),
  )
  await flush()
  assert.deepEqual(claude.sent[0], { type: 'user', message: { role: 'user', content: '第一句' } })
  claude.rpc.handle({ type: 'result', subtype: 'success', session_id: 's1' })
  await flush()
  // 一轮结束、进程留着时要一次上下文细分（get_context_usage，summary 不额外调接口），回复按类别 id 归到共用的分类
  const ask = claude.sent.at(-1)
  assert.equal(ask.request.subtype, 'get_context_usage')
  assert.equal(ask.request.detail, 'summary')
  assert.equal(claude.rpc.waiting, true, '不等细分回来，这一轮照常结束')
  claude.rpc.handle({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: ask.request_id,
      response: {
        // 2.1.3xx 的回复里类别只有 name（界面上显示的那几个），没有早期版本的 id 字段；
        // 只按 id 找会让所有类别都认不出，快照 rows 为空、上下文占用恒为 0
        categories: [
          { name: 'System prompt', tokens: 2034 },
          { name: 'System tools', tokens: 28725 },
          { name: 'System tools (deferred)', tokens: 34202, isDeferred: true },
          { name: 'MCP server instructions', tokens: 900 },
          { name: 'Messages', tokens: 5000 },
          { name: 'Autocompact buffer', tokens: 33000 },
          { name: 'Free space', tokens: 930341 },
          { name: 'Something new', tokens: 1 },
        ],
        maxTokens: 1_000_000,
        mcpTools: [{ name: 'mcp__panel__ask', tokens: 300, isLoaded: true }],
        deferredBuiltinTools: [{ name: 'WebFetch', tokens: 800, isLoaded: false }],
        skills: { skillFrontmatter: [{ name: 'docs', tokens: 101 }] },
      },
    },
  })
  await flush()
  const snap = claude.events.find((e) => e.type === 'context')?.snapshot
  assert.ok(snap, '细分交给了面板')
  // 认不出的类别丢掉；占窗口的是提示词、工具、MCP 说明和消息，按需的工具、余量、空闲不算
  assert.deepEqual(
    snap.rows.map((r: any) => r.key),
    ['systemPrompt', 'systemTools', 'systemDeferred', 'mcpInstructions', 'messages', 'buffer', 'free'],
  )
  assert.equal(snap.used, 2034 + 28725 + 900 + 5000)
  // 早期版本按 id 报类别：同一套分类也要认得（先按 id、再按 name）
  const legacy = claudeContextSnapshot({
    categories: [
      { id: 'system_prompt', tokens: 10 },
      { id: 'messages', tokens: 20 },
    ],
    maxTokens: 1000,
  })
  assert.deepEqual(
    legacy?.rows.map((r) => r.key),
    ['systemPrompt', 'messages'],
  )
  assert.deepEqual(
    snap.tools.map((x: any) => [x.name, x.deferred]),
    [
      ['mcp__panel__ask', false],
      ['WebFetch', true],
    ],
  )
  assert.equal(claude.ended(), false, '一轮结束后进程留着')
  assert.equal(claude.rpc.waiting, true, '在等用户下一句')

  await next(claude, '第二句')
  const claudeNext = claude.sent.at(-1)
  assert.deepEqual(
    claudeNext,
    { type: 'user', message: { role: 'user', content: '第二句' } },
    '下一句直接交给同一个进程',
  )
  assert.equal('priority' in claudeNext, false, '不是插话，是新一轮')
  assert.equal(claude.rpc.finished, false, '已经进入下一轮')
  assert.equal(claude.rpc.waiting, false)

  // Codex：同一个 thread 再发 turn/start，不重新 initialize / thread/start
  const codex = session(
    codexAdapter({
      cwd: process.cwd(),
      input: '第一句',
      model: 'gpt-6.1-sol',
      permission: 'workspace-write',
      extraArgs: [],
      platform: 'linux',
    }),
  )
  const req = (method: string) => codex.sent.find((x) => x.method === method)!
  await flush()
  codex.rpc.handle({ id: req('initialize').id, result: {} })
  await flush()
  codex.rpc.handle({ id: req('thread/start').id, result: { thread: { id: 'th1' } } })
  await flush()
  codex.rpc.handle({ id: req('turn/start').id, result: { turn: { id: 't1' } } })
  await flush()
  codex.rpc.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await flush()
  assert.equal(codex.ended(), false, '一轮结束后进程留着')
  assert.equal(codex.rpc.waiting, true, '在等用户下一句')

  await next(codex, '第二句')
  const turns = codex.sent.filter((x) => x.method === 'turn/start')
  assert.equal(turns.length, 2, '同一进程里开了第二轮')
  assert.equal(turns[1].params.threadId, 'th1', '接着原来的 thread')
  assert.equal(turns[1].params.input[0].text, '第二句', '下一句交给同一个 thread')
  assert.equal(codex.sent.filter((x) => x.method === 'thread/start').length, 1, '没有重新开会话')
  assert.equal(codex.ended(), false)
})
