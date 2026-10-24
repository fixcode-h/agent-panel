import type { McpServer } from '@shared/library'
import type { ProjectMcpDetected, ProjectMcpImportResult, ProjectMcpOverview } from '@shared/project-mcp'
import { t } from '@shared/i18n'
import { demoMcpOverview, demoMcpServers } from './demo-library'

/**
 * 在线演示里的项目 MCP：浏览器里读不到项目目录，识别到的配置是固定几条演示数据，
 * 但字段和真后端（server/project-mcp.ts）一致，导入也真的改动内存里那份面板管理的工具。
 */

const entry = (
  name: string,
  file: string,
  source: string,
  server: Omit<McpServer, 'name'>,
): Omit<ProjectMcpDetected, 'status'> => ({
  name,
  server: { name, ...server },
  file,
  source,
  raw: JSON.stringify({ name, ...server }, null, 2),
  nameOk: /^[A-Za-z0-9][\w-]*$/.test(name),
})

/** 三种状态各有一条：只在项目里（browser）、和面板里一样（filesystem）、同名但配置不同（github） */
const detected: Omit<ProjectMcpDetected, 'status'>[] = [
  entry('github', '.mcp.json', 'Claude Code 项目配置', {
    transport: 'http',
    command: '',
    args: [],
    env: {},
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer ghp_project' },
  }),
  entry('filesystem', '.mcp.json', 'Claude Code 项目配置', {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~/projects'],
    env: {},
    url: '',
    headers: {},
  }),
  entry('browser', '.vscode/mcp.json', 'VS Code 工作区配置', {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    env: {},
    url: '',
    headers: {},
  }),
  entry('postgres', '.codex/config.toml', 'Codex 项目配置', {
    transport: 'stdio',
    command: 'docker',
    args: ['run', '-i', '--rm', 'mcp/postgres'],
    env: { DATABASE_URL: 'postgres://localhost/demo' },
    url: '',
    headers: {},
  }),
]

/** 只看配置内容：名字和「装在哪些 Agent」不算（全局那条是 McpEntry，多了 clis 字段） */
const same = (a: McpServer, b: McpServer) =>
  JSON.stringify({ ...a, name: '', clis: undefined }) === JSON.stringify({ ...b, name: '', clis: undefined })

function overview(active: string[], path: string): ProjectMcpOverview {
  const base = demoMcpOverview(active)
  const global = new Map(base.servers.map((s) => [s.name, s]))
  return {
    path,
    clis: base.clis,
    servers: base.servers,
    detected: detected.map((d) => {
      const cur = global.get(d.name)
      return { ...d, status: !cur ? 'new' : same(d.server, cur) ? 'same' : 'different' }
    }),
    errors: [],
  }
}

/** 把项目里的一条写进面板管理的那份（演示版只在内存里） */
function install(server: McpServer, clis: string[]) {
  const at = demoMcpServers.findIndex((s) => s.name === server.name)
  if (at >= 0) demoMcpServers.splice(at, 1, { ...server, clis })
  else demoMcpServers.push({ ...server, clis })
}

export function demoProjectMcp(method: string, seg: string[], body: any, active: string[], path: string): unknown {
  const id = seg[1] ?? ''
  if (id === 'test')
    return {
      ok: true,
      server: (body as McpServer).name,
      tools: [
        { name: 'read_file', description: '读一个文件的内容' },
        { name: 'list_directory', description: '列出目录下的文件' },
      ],
    }
  if (id === 'import') {
    const result: ProjectMcpImportResult = { overview: overview(active, path), done: [], skipped: [] }
    const all = demoMcpOverview(active).clis.map((c) => c.id)
    for (const item of (body.items ?? []) as { file: string; name: string; clis?: string[] }[]) {
      const hit = detected.find((d) => d.file === item.file && d.name === item.name)
      if (!hit) {
        result.skipped.push({ name: item.name, file: item.file, reason: t('项目里已经没有这条配置了') })
        continue
      }
      if (!hit.nameOk) {
        result.skipped.push({ name: hit.name, file: hit.file, reason: t('工具名只能用字母、数字、- 和 _') })
        continue
      }
      install(hit.server, item.clis?.length ? item.clis.filter((x) => all.includes(x)) : all)
      result.done.push({ name: hit.name, file: hit.file })
    }
    return { ...result, overview: overview(active, path) }
  }
  if (!id) return overview(active, path)
  const name = decodeURIComponent(id)
  if (method === 'DELETE') {
    const at = demoMcpServers.findIndex((s) => s.name === name)
    if (at >= 0) demoMcpServers.splice(at, 1)
  } else if (method === 'PUT') {
    const at = demoMcpServers.findIndex((s) => s.name === name)
    if (at >= 0) demoMcpServers.splice(at, 1)
    demoMcpServers.push({ ...(body.server as McpServer), name, clis: body.clis ?? [] })
  }
  return overview(active, path)
}
