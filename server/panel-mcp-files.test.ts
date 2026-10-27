import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyConfigFiles, openAskBridge } from './ask-mcp.ts'
import { claimPanelName, PANEL_MCP_NAME, stripStalePanelMcp, sweepPanelMcp } from './panel-mcp-files.ts'
import { isPanelMcpUrl } from '../shared/project-mcp.ts'

const port = Number(process.env.PORT ?? 8787)
const url = (token: string, kind = 'ask') => `http://127.0.0.1:${port}/api/mcp/${kind}/${token}`
const entry = (token: string) => ({ transport: 'http', url: url(token) })
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

test('面板自己的 MCP 地址认得出来：ask 和老版本的 orch，别的地址不算', () => {
  assert.ok(isPanelMcpUrl('http://127.0.0.1:8787/api/mcp/ask/d2eb9851-fd99-4665-af13-25ab9948dcdc'))
  assert.ok(isPanelMcpUrl('http://127.0.0.1:8787/api/mcp/orch/60a795a2-28a2-48f0-9b3d-497985784013'))
  assert.ok(isPanelMcpUrl('http://localhost:8787/api/mcp/ask/abc', 8787))
  assert.ok(!isPanelMcpUrl('http://127.0.0.1:9000/api/mcp/ask/abc', 8787), '别的端口可能是另一个面板')
  assert.ok(!isPanelMcpUrl('https://example.com/mcp'))
  assert.ok(!isPanelMcpUrl(undefined))
})

test('同一个目录里第一轮叫 agent-panel，同时在跑的另几轮才带后缀，用完名字还回去', () => {
  const a = claimPanelName('/p', 'aaaaaa')
  const b = claimPanelName('/p', 'bbbbbb')
  const other = claimPanelName('/q', 'cccccc')
  assert.equal(a.name, PANEL_MCP_NAME)
  assert.equal(b.name, `${PANEL_MCP_NAME}-bbbbbb`)
  assert.equal(other.name, PANEL_MCP_NAME)
  a.release()
  const c = claimPanelName('/p', 'dddddd')
  assert.equal(c.name, PANEL_MCP_NAME)
  for (const s of [b, c, other]) s.release()
})

test('只删失效的面板条目和对应的权限放行，用户自己的和还在用的都留着', () => {
  const live = new Set(['live-token'])
  const root = {
    mcpServers: {
      mine: { command: 'npx', args: ['x'] },
      remote: { url: 'https://example.com/mcp' },
      panel: entry('dead-1'),
      orch: { url: url('dead-2', 'orch') },
      'panel-14da55': entry('dead-3'),
      [PANEL_MCP_NAME]: entry('live-token'),
      'other-port': { url: 'http://127.0.0.1:1/api/mcp/ask/x' },
    },
    permissions: {
      allow: ['mcp__panel-14da55__*', 'mcp__panel-aaaaaa__*', `mcp__${PANEL_MCP_NAME}__*`, 'mcp__mine__*'],
    },
  }
  const out = stripStalePanelMcp(root, { port, live: (t) => live.has(t), inUse: new Set([PANEL_MCP_NAME]) }) as any
  assert.deepEqual(Object.keys(out.mcpServers), ['mine', 'remote', PANEL_MCP_NAME, 'other-port'])
  assert.deepEqual(out.permissions.allow, [`mcp__${PANEL_MCP_NAME}__*`, 'mcp__mine__*'])
  assert.equal(
    stripStalePanelMcp({ mcpServers: { mine: { command: 'x' } } }, { port, live: () => false, inUse: new Set() }),
    undefined,
  )
})

test('清理项目目录：全是面板留下的文件直接删掉，混着用户配置的只删面板那几项', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panel-sweep-'))
  writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { mine: { command: 'x' }, panel: entry('gone') } }),
  )
  mkdirSync(path.join(dir, '.commandcode'))
  writeFileSync(
    path.join(dir, '.commandcode', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['mcp__panel-1f1d3a__*'] } }),
  )
  assert.equal(await sweepPanelMcp(dir), 2)
  assert.deepEqual(read(path.join(dir, '.mcp.json')), { mcpServers: { mine: { command: 'x' } } })
  assert.ok(!existsSync(path.join(dir, '.commandcode', 'settings.json')))
  assert.equal(await sweepPanelMcp(dir), 0, '再清一遍没有要动的')
})

test('一轮结束只撤掉自己那一项：同时在跑的另一轮、执行期间用户加的配置都留着，原文格式不变', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panel-apply-'))
  const file = path.join(dir, '.mcp.json')
  const original = '{\n    "mcpServers": { "mine": { "command": "x" } }\n}\n'
  writeFileSync(file, original)
  const a = openAskBridge({ notes: () => [] })
  const b = openAskBridge({ notes: () => [] })
  const restoreA = await applyConfigFiles(dir, [
    { path: '.mcp.json', content: { mcpServers: { [PANEL_MCP_NAME]: { url: a.url } } } },
  ])
  const restoreB = await applyConfigFiles(dir, [
    { path: '.mcp.json', content: { mcpServers: { 'agent-panel-bbbbbb': { url: b.url } } } },
  ])
  // 执行期间用户自己加了一项
  const now = read(file)
  now.mcpServers.added = { command: 'y' }
  writeFileSync(file, JSON.stringify(now))
  // 另一轮在跑时清理不会删掉还在用的
  assert.equal(await sweepPanelMcp(dir), 0)
  await restoreA()
  assert.deepEqual(Object.keys(read(file).mcpServers), ['mine', 'agent-panel-bbbbbb', 'added'])
  await restoreB()
  assert.deepEqual(read(file), { mcpServers: { mine: { command: 'x' }, added: { command: 'y' } } })
  a.close()
  b.close()

  // 用户没动过：撤完原样写回原文
  writeFileSync(file, original)
  const r = await applyConfigFiles(dir, [
    { path: '.mcp.json', content: { mcpServers: { [PANEL_MCP_NAME]: { url: url('t') } } } },
  ])
  assert.ok(read(file).mcpServers[PANEL_MCP_NAME])
  await r()
  assert.equal(readFileSync(file, 'utf8'), original)

  // 这一轮新建的文件：撤完只剩空壳就删掉
  const r3 = await applyConfigFiles(dir, [
    { path: '.commandcode/settings.json', content: { mcpServers: { x: { httpUrl: url('t') } } } },
  ])
  await r3()
  assert.ok(!existsSync(path.join(dir, '.commandcode', 'settings.json')))
})
