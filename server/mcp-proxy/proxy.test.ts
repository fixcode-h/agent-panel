/**
 * 外部 MCP 服务代理（ADR 0085）：开跑时按 CLI 会挂的服务问工具表、能代理的代理、连不上的退回直接挂（带进参数）；
 * more_tools 的代理调用转给假服务（等索引、看用法、被接管的拒绝并指到 find）、出错记一笔后下一轮退回直接挂；
 * 设置里关掉代理就整轮照旧；网关把代理调用记成 kind mcp。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-proxy-'))
process.env.AGENT_PANEL_DATA = path.join(root, 'data')
// 全局配置读临时目录：不碰本机的 ~/.claude.json
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')

const { getCli } = await import('../../shared/clis.ts')
const { AUDIENCE_REPS } = await import('../mcp-catalog/audiences.ts')
const { closeMcpPool } = await import('../mcp-client/pool.ts')
const { setMcpProxy } = await import('../hooks/store.ts')
const { openGateway } = await import('../tool-gateway/gateway.ts')
const { recentCalls } = await import('../tool-gateway/call-log.ts')
const { proxyForRun } = await import('./launch.ts')
const { serveProxied } = await import('./serve.ts')
const { exposureRuns, recentFailure, resetProxyState } = await import('./state.ts')

after(() => closeMcpPool())

// 假的 stdio MCP 服务：工具表三个；lua_debug_session 第一次答「正在建索引」，之后把参数原样回来
const FAKE = `
let n = 0
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const tools = [
  { name: 'lua_code', description: '找 Lua 代码。', inputSchema: { type: 'object' } },
  { name: 'lua_debug_session', description: '调试会话。第二句', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
]
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id === undefined) continue
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'fake' }, capabilities: {} } })
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } })
    else if (m.method === 'tools/call') {
      if (++n === 1) send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'indexing', message: '稍后' }) }] } })
      else send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ got: m.params.arguments, cwd: process.cwd() }) }] } })
    } else send({ jsonrpc: '2.0', id: m.id, result: {} })
  }
})
`

const def = getCli('claude')!
// 能拿到 find 的子对话：find 接管才生效
const orch = { ...AUDIENCE_REPS.child, findCode: async () => ({ text: '' }) } as never

async function project() {
  const dir = path.join(root, 'proj')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'fake.mjs'), FAKE)
  await writeFile(
    path.join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        idea: { command: process.execPath, args: [path.join(dir, 'fake.mjs')] },
        // 没人听的端口：连不上，退回直接挂
        gone: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
      },
    }),
  )
  return dir
}

const opts = (cwd: string) => ({ cwd, projectId: 'p1', taskTitle: '对话', orch, own: ['ue'] })

test('开跑：能代理的代理（lua_code 被 find 接管不给），连不上的退回直接挂并带进参数；面板没接上时照旧', async () => {
  resetProxyState()
  const cwd = await project()
  const run = (await proxyForRun(def, opts(cwd)))!
  assert.ok(run.session, '有服务经代理')
  const [gone, idea] = [...run.session.plan.servers].sort((a, b) => a.name.localeCompare(b.name))
  assert.deepEqual([idea.mode, idea.why], ['proxy', 'proxied'])
  assert.deepEqual(
    idea.tools.map((x) => [x.name, x.shown]),
    [
      ['lua_code', false],
      ['lua_debug_session', true],
    ],
  )
  assert.deepEqual([gone.mode, gone.why], ['direct', 'unreachable'])
  const args = run.args(true, ['panel', 'ue'])!
  assert.equal(args[0], '--strict-mcp-config')
  const json = args.slice(1).join(' ')
  assert.match(json, /"gone"/, '退回的服务由面板逐个带上')
  assert.doesNotMatch(json, /"idea"/, '代理的服务不再直接挂')
  assert.equal(run.args(false, ['panel']), undefined, '面板服务没接上：不加只挂面板，CLI 照旧自己读配置')
  const [rec] = await exposureRuns('p1')
  assert.equal(rec.cli, 'claude')
})

test('代理调用：看用法给原样的参数表，调用等索引后转回结果并挂上 via mcp 的路；被接管的指到 find', async () => {
  resetProxyState()
  const cwd = await project()
  const s = (await proxyForRun(def, opts(cwd)))!.session!
  const usage = await serveProxied(s, [], { name: 'idea/lua_debug_session' })!
  assert.match(usage.content[0].text, /"action"/)
  const routes: [unknown, string][] = []
  const r = await serveProxied(
    s,
    [],
    { name: 'idea/lua_debug_session', arguments: { action: 'status' } },
    undefined,
    (route, needle) => routes.push([route, needle]),
  )!
  assert.ok(!r.isError, r.content[0].text)
  assert.deepEqual(JSON.parse(r.content[0].text).got, { action: 'status' })
  assert.equal(routes[0][1], 'idea/lua_debug_session')
  assert.deepEqual((routes[0][0] as { served: unknown[] }).served, [
    { source: 'proxy:idea', label: 'idea · lua_debug_session', via: 'mcp' },
  ])
  const hidden = await serveProxied(s, [], { name: 'idea/lua_code', arguments: {} })!
  assert.ok(hidden.isError)
  assert.match(hidden.content[0].text, /改用面板工具 find/)
  assert.match((await serveProxied(s, [], { name: 'idea/' })!).content[0].text, /idea\/lua_debug_session：调试会话/)
  assert.equal(serveProxied(s, ['list_peers'], { name: 'list_peers' }), undefined, '面板自己收起来的交回 more_tools')
})

test('代理出错：这次说清没执行和下一步，记一笔，下一轮开跑时这个服务退回直接挂', async () => {
  resetProxyState()
  const cwd = await project()
  const s = (await proxyForRun(def, opts(cwd)))!.session!
  // 服务进程起不来（命令换成不存在的）：连接错
  s.servers.set('idea', { ...s.servers.get('idea')!, server: { ...s.servers.get('idea')!.server, command: '/nope/x' } })
  closeMcpPool()
  const r = await serveProxied(s, [], { name: 'idea/lua_debug_session', arguments: {} })!
  assert.ok(r.isError)
  assert.match(r.content[0].text, /这次没有执行/)
  assert.ok(recentFailure('idea'))
  const next = await proxyForRun(def, opts(cwd))
  assert.equal(next, undefined, '两个服务都代理不了：这一轮照旧直接挂')
  const [rec] = await exposureRuns('p1')
  assert.deepEqual(rec.plan.servers.map((x) => [x.name, x.why]).sort(), [
    ['gone', 'unreachable'],
    ['idea', 'failed'],
  ])
})

test('设置里关掉代理：整轮照旧直接挂；网关把 more_tools 的代理调用记成 mcp 调用', async () => {
  resetProxyState()
  const cwd = await project()
  await setMcpProxy(false)
  assert.equal(await proxyForRun(def, opts(cwd)), undefined)
  const [rec] = await exposureRuns('p1')
  assert.ok(rec.plan.servers.every((x) => x.why === 'off'))
  await setMcpProxy(true)

  const gw = openGateway({
    mode: 'observe',
    task: { id: 't1', title: '对话' },
    projectId: 'p-gw',
    cliId: 'claude',
    claimCtx: async () => ({ customTools: [] }),
  })!
  const facts = {
    tool: {
      kind: 'panel' as const,
      name: 'mcp__panel__more_tools',
      panel: 'more_tools',
      input: { name: 'idea/lua_code', arguments: { action: 'search', query: 'OnInit' } },
      path: '',
      paths: [],
    },
  }
  await gw.wrap(async () => ({}))('tool.before', facts)
  const [call] = recentCalls('p-gw')
  assert.equal(call.kind, 'mcp')
  assert.deepEqual(call.mcp, { server: 'idea', tool: 'lua_code', proxied: true })
  assert.equal(call.capability, 'find', '能力表按外部工具认')
})
