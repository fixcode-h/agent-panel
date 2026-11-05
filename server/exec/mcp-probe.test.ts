import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { McpProbe } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { probeProjectMcp, warnSlowMcp } from './mcp-probe.ts'

const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

/** 起三个服务：正常回答的、收下请求不回的（像主线程被占住的 Unreal 插件）、已经关掉的端口 */
async function setup() {
  const ok = createServer((_q, res) => res.writeHead(401).end())
  const held: import('node:http').ServerResponse[] = []
  const hang = createServer((_q, res) => void held.push(res))
  const gone = createServer()
  const [okPort, hangPort, gonePort] = await Promise.all([listen(ok), listen(hang), listen(gone)])
  await new Promise((r) => gone.close(r))
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-probe-'))
  writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        Alive: { type: 'http', url: `http://127.0.0.1:${okPort}/mcp` },
        UnrealMCP: { type: 'http', url: `http://127.0.0.1:${hangPort}/mcp` },
        Gone: { type: 'http', url: `http://127.0.0.1:${gonePort}/mcp` },
        Local: { command: 'node', args: ['x.js'] },
        // 面板自己临时写进来的条目不算
        'agent-panel': { type: 'http', url: 'http://127.0.0.1:8787/api/mcp/ask/abc' },
      },
    }),
  )
  const close = async () => {
    for (const r of held) r.destroy()
    hang.closeAllConnections()
    await Promise.all([new Promise((r) => ok.close(r)), new Promise((r) => hang.close(r))])
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, close }
}

test('探测项目 MCP：有回应（哪怕 401）算活着，不回应和连不上的报出来，本地命令和面板条目不探', async () => {
  const { dir, close } = await setup()
  try {
    const probe = McpProbe.parse({ files: ['.mcp.json', 'missing.json'], timeoutMs: 300 })
    const miss = await probeProjectMcp(dir, probe)
    assert.deepEqual(miss.map((m) => [m.name, m.kind]).sort(), [
      ['Gone', 'refused'],
      ['UnrealMCP', 'silent'],
    ])
  } finally {
    await close()
  }
})

test('不响应的 MCP 写一行警告，按启动时的环境变量说最多等几秒', async () => {
  const { dir, close } = await setup()
  try {
    const task = { id: 't1', messages: [] as any[] } as any
    let changed = 0
    await new Promise<void>((done) => {
      warnSlowMcp({
        task,
        cli: 'Claude Code',
        probe: McpProbe.parse({ files: ['.mcp.json'], waitEnv: 'WAIT_MS', timeoutMs: 300 }),
        cwd: dir,
        env: { WAIT_MS: '3000' },
        agentId: 'a',
        step: '',
        newId: () => 'm1',
        changed: () => (changed++, done()),
      })
    })
    assert.equal(changed, 1)
    const m = task.messages[0]
    assert.equal(m.alert.kind, 'mcp_slow')
    assert.match(m.text, /UnrealMCP/)
    assert.match(m.text, /\b3\b/)
    assert.doesNotMatch(m.text, /Alive/)
  } finally {
    await close()
  }
})

test('Claude Code 的定义：探测 .mcp.json，第一轮等 MCP 的上限写在默认环境变量里', () => {
  const def = getCli('claude')!
  assert.ok(def.mcpProbe?.files.includes('.mcp.json'))
  const env = def.mcpProbe!.waitEnv!
  assert.ok(Number(def.env?.[env]) > 0)
})
