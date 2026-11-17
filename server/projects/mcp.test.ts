import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CLIS } from '../../shared/clis.ts'
import { Settings } from '../../shared/schema.ts'
import type { ProjectMcpImportResult, ProjectMcpOverview } from '../../shared/projects/mcp.ts'

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
const { expandHome } = await import('../cli/extras.ts')
const { projectMcpApi } = await import('./mcp.ts')

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('项目 MCP：识别常见配置文件，项目里的自动导入并打开，Agent 里的列为可导入', async () => {
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

    // 打开项目时读到的配置自动导入成按项目的条目，并在这个项目里打开（用户 2026-11-17 定）
    const enabled: string[][] = []
    const api = projectMcpApi({
      projectPath: async () => dir,
      enableMcp: async (_id, names) => void enabled.push(names),
    })
    const first = (await (await api.request('/?projectId=p1')).json()) as ProjectMcpOverview
    assert.deepEqual(first.detected.map((d) => `${d.file}:${d.name}`).sort(), [
      '.codex/config.toml:pg',
      '.mcp.json:fs',
      '.mcp.json:web',
      '.vscode/mcp.json:browser',
    ])
    assert.deepEqual([...(first.autoEnabled ?? [])].sort(), ['browser', 'fs', 'pg', 'web'])
    assert.deepEqual([...enabled[0]].sort(), ['browser', 'fs', 'pg', 'web'])
    assert.ok(first.detected.every((d) => d.status === 'same'))
    assert.ok(first.servers.filter((x) => x.name !== 'local').every((x) => x.activation === 'project'))
    assert.equal(first.detected.find((d) => d.name === 'web')?.server.transport, 'http')
    assert.equal(first.detected.find((d) => d.name === 'browser')?.source, 'VS Code 工作区配置')
    // 项目里的文件一字不动
    assert.equal(readFileSync(path.join(dir, '.mcp.json'), 'utf8'), mcpJson)
    // 读不懂的文件只记进 errors，别的文件照常读
    assert.deepEqual(
      first.errors.map((e) => e.file),
      ['.claude/settings.json'],
    )

    // 再读一次（用户可能已经在项目里关掉了某条）：处理过的名字不再自动打开
    const again = (await (await api.request('/?projectId=p1')).json()) as ProjectMcpOverview
    assert.equal(again.autoEnabled, undefined)
    assert.equal(enabled.length, 1)
    // 项目里后来新加的一条照样自动导入，只处理新的这条
    mkdirSync(path.join(dir, '.cursor'), { recursive: true })
    writeFileSync(
      path.join(dir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { url: 'https://d.example/mcp' } } }),
    )
    const third = (await (await api.request('/?projectId=p1')).json()) as ProjectMcpOverview
    assert.deepEqual(third.autoEnabled, ['docs'])
    // 另一个项目第一次读到同样的配置：条目已在面板库里、配置一样，只在那个项目里打开，不重复导入
    const other = (await (await api.request('/?projectId=p2')).json()) as ProjectMcpOverview
    assert.deepEqual([...(other.autoEnabled ?? [])].sort(), ['browser', 'docs', 'fs', 'pg', 'web'])

    // Agent 自己配置里只对这个项目生效的（Claude Code 的 local scope）：识别出来列为可导入，不自动导入
    const claude = CLIS.find((d) => d.mcpStore?.projectTable && first.clis.some((c) => c.id === d.id))
    assert.ok(claude, '应该有在全局配置里按项目存 MCP 的 CLI')
    const claudeFile = expandHome(claude.mcpStore!.file)
    const before = existsSync(claudeFile) ? JSON.parse(readFileSync(claudeFile, 'utf8')) : {}
    before.projects = { [dir]: { mcpServers: { local: { command: 'uvx', args: ['local-mcp'] } } } }
    writeFileSync(claudeFile, JSON.stringify(before))
    const withAgent = (await (await api.request('/?projectId=p1')).json()) as ProjectMcpOverview
    const local = withAgent.detected.find((d) => d.name === 'local')
    assert.equal(local?.fromAgent, true)
    assert.equal(local?.status, 'new')
    assert.equal(withAgent.autoEnabled, undefined)
    // 用户手动导入：成为按项目的条目，并在这个项目里打开
    const res = (await (
      await api.request('/import?projectId=p1', post({ items: [{ file: local!.file, name: 'local' }] }))
    ).json()) as ProjectMcpImportResult
    assert.deepEqual(res.done, [{ name: 'local', file: local!.file }])
    assert.deepEqual(res.skipped, [])
    assert.deepEqual(enabled.at(-1), ['local'])
    assert.equal(res.overview.detected.find((d) => d.name === 'local')?.status, 'same')
    assert.equal(res.overview.servers.find((s) => s.name === 'local')?.activation, 'project')

    // 项目还没设目录时只返回面板管理的，不去扫磁盘
    const empty = (await (
      await projectMcpApi({ projectPath: async () => '', enableMcp: async () => {} }).request('/')
    ).json()) as ProjectMcpOverview
    assert.equal(empty.path, '')
    assert.deepEqual(empty.detected, [])
  } finally {
    // 按键还原：process.env = old 会换成普通对象，之后再设 HOME，os.homedir() 读不到（rules-check 第 17 条）
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]
    Object.assign(process.env, old)
  }
})
