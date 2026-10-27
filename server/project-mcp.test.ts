import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CLIS } from '../shared/clis.ts'
import { Settings } from '../shared/schema.ts'
import type { ProjectMcpImportResult, ProjectMcpOverview } from '../shared/project-mcp.ts'

// 数据目录在模块加载时就定死（server/store.ts 的 DATA_DIR）：先把 AGENT_PANEL_DATA 指到临时目录，再加载被测模块。
// 不然读的是本机真实的 settings.json——本机启用过 CLI 才过，CI 的干净 HOME 上 clis 是空的
const dataDir = mkdtempSync(path.join(tmpdir(), 'projmcp-data-'))
process.env.AGENT_PANEL_DATA = dataDir
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
// 新装用户的设置里所有 CLI 默认都不启用：显式打开能管 MCP 的几个，测试不依赖本机装没装 CLI、有没有启用过
writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify(
    Settings.parse({
      language: 'zh',
      clis: Object.fromEntries(CLIS.map((c) => [c.id, { enabled: !!c.mcpStore }])),
    }),
  ),
)
const { expandHome } = await import('./cli-extras.ts')
const { projectMcpApi } = await import('./project-mcp.ts')

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('项目 MCP：识别常见配置文件，导入只写 CLI 的全局配置', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'projmcp-home-'))
  const dir = mkdtempSync(path.join(tmpdir(), 'projmcp-project-'))
  const old = { ...process.env }
  // Windows 上 os.homedir() 读 USERPROFILE，两个都设才能隔离到临时目录
  process.env.HOME = home
  process.env.USERPROFILE = home
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR']) delete process.env[k]
  try {
    // Claude Code 的 .mcp.json（mcpServers）、VS Code 的 .vscode/mcp.json（servers）、Codex 的 config.toml、读不懂的设置文件
    const mcpJson = JSON.stringify(
      {
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'fs-mcp'] },
          web: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
          // 面板执行时临时写进来的自己的 MCP（含老版本留下的）：不列成可导入项
          'panel-19f169': { transport: 'http', url: 'http://127.0.0.1:8787/api/mcp/ask/154197b1-7a0d-40fe' },
          orch: { url: 'http://127.0.0.1:8787/api/mcp/orch/60a795a2-28a2-48f0' },
        },
      },
      null,
      2,
    )
    writeFileSync(path.join(dir, '.mcp.json'), mcpJson)
    mkdirSync(path.join(dir, '.vscode'), { recursive: true })
    writeFileSync(
      path.join(dir, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: { browser: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] } } }),
    )
    mkdirSync(path.join(dir, '.codex'), { recursive: true })
    writeFileSync(
      path.join(dir, '.codex', 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.pg]\ncommand = "docker"\nargs = ["run", "mcp/postgres"]\n',
    )
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ 坏掉的 json')

    const api = projectMcpApi({ projectPath: async () => dir })
    const first = (await (await api.request('/?projectId=p1')).json()) as ProjectMcpOverview
    assert.deepEqual(first.detected.map((d) => `${d.file}:${d.name}`).sort(), [
      '.codex/config.toml:pg',
      '.mcp.json:fs',
      '.mcp.json:web',
      '.vscode/mcp.json:browser',
    ])
    assert.ok(first.detected.every((d) => d.status === 'new'))
    assert.equal(first.detected.find((d) => d.name === 'web')?.server.transport, 'http')
    assert.equal(first.detected.find((d) => d.name === 'browser')?.source, 'VS Code 工作区配置')
    // 读不懂的文件只记进 errors，别的文件照常读
    assert.deepEqual(
      first.errors.map((e) => e.file),
      ['.claude/settings.json'],
    )

    // 导入一条到某一个 CLI：写的是它的全局配置，项目里的文件一字不动
    const target = CLIS.filter((d) => d.mcpStore && first.clis.some((c) => c.id === d.id))[0]
    assert.ok(target, '临时用户目录里应该至少有一个能管 MCP 的 CLI')
    const res = (await (
      await api.request('/import?projectId=p1', post({ items: [{ file: '.mcp.json', name: 'fs', clis: [target.id] }] }))
    ).json()) as ProjectMcpImportResult
    assert.deepEqual(res.done, [{ name: 'fs', file: '.mcp.json' }])
    assert.deepEqual(res.skipped, [])
    assert.equal(readFileSync(path.join(dir, '.mcp.json'), 'utf8'), mcpJson)
    const global = expandHome(target.mcpStore!.file)
    assert.ok(existsSync(global), '应该写进这个 CLI 的全局配置文件')
    assert.ok(readFileSync(global, 'utf8').includes('fs-mcp'))
    // 再读一次：这条和全局一致了
    assert.equal(res.overview.detected.find((d) => d.name === 'fs')?.status, 'same')
    assert.equal(res.overview.servers.find((s) => s.name === 'fs')?.clis.includes(target.id), true)

    // 项目还没设目录时只返回面板管理的，不去扫磁盘
    const empty = (await (
      await projectMcpApi({ projectPath: async () => '' }).request('/')
    ).json()) as ProjectMcpOverview
    assert.equal(empty.path, '')
    assert.deepEqual(empty.detected, [])
  } finally {
    process.env = old
  }
})
