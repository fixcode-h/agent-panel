import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { McpStore } from '../shared/cli-spec.ts'
import { McpServer } from '../shared/library.ts'
import { t } from '../shared/i18n.ts'
import {
  isPanelMcpUrl,
  type ProjectMcpDetected,
  type ProjectMcpImportResult,
  type ProjectMcpOverview,
} from '../shared/project-mcp.ts'
import { mcpOverview, readServerTable, readToml, removeMcpFrom, testMcp, writeMcpTo } from './mcp-store.ts'

/**
 * 项目设置里的「MCP」：列出这个项目的目录里各工具认的 MCP 配置，可以一键导入成面板管理的配置。
 *
 * 只读用户的文件。导入写的是各 CLI 的全局配置（mcp-store 那套，只动 mcpServers 里自己那几段），
 * 项目里的配置文件原文一直留在用户自己手里，所以不需要备份、也不会被改坏。
 */

const jsonStore = (key: string) => McpStore.parse({ file: '', format: 'json', key })
const tomlStore = McpStore.parse({
  file: '',
  format: 'toml',
  key: 'mcp_servers',
  urlKey: 'url',
  headersKey: 'http_headers',
})

interface Source {
  /** 相对项目根的文件 */
  file: string
  store: McpStore
  /** 界面上标在文件名后面的来源说明 */
  source: string
}

/**
 * 项目级 MCP 配置放在哪，按各工具官方文档里的写法：
 * - Claude Code：项目根 .mcp.json（项目级 scope），顶层 mcpServers；设置文件里也能写 mcpServers
 * - Cursor：.cursor/mcp.json，顶层 mcpServers
 * - VS Code：工作区 .vscode/mcp.json，顶层 servers（条目的 type 是 stdio / http）
 * - Codex：.codex/config.toml，[mcp_servers.名字] 表
 * 条目结构和面板的 McpServer 一致（command/args/env 或 url/headers），读取时各种别名都认（见 readServerTable）。
 */
const SOURCES: Source[] = [
  { file: '.mcp.json', store: jsonStore('mcpServers'), source: 'Claude Code 项目配置' },
  { file: '.claude/settings.json', store: jsonStore('mcpServers'), source: 'Claude Code 设置' },
  { file: '.claude/settings.local.json', store: jsonStore('mcpServers'), source: 'Claude Code 本地设置' },
  { file: '.cursor/mcp.json', store: jsonStore('mcpServers'), source: 'Cursor 项目配置' },
  { file: '.vscode/mcp.json', store: jsonStore('servers'), source: 'VS Code 工作区配置' },
  { file: '.codex/config.toml', store: tomlStore, source: 'Codex 项目配置' },
]

/** 配置内容是否一样（不算名字和装在哪几个 CLI） */
const sameServer = (a: McpServer, b: McpServer) => {
  const norm = (v: Record<string, string>) => JSON.stringify(Object.entries(v).sort())
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    a.url === b.url &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    norm(a.env) === norm(b.env) &&
    norm(a.headers) === norm(b.headers)
  )
}

const nameOk = (name: string) => /^[A-Za-z0-9][\w-]*$/.test(name)

/** 读项目目录里的配置文件；读不懂的一个只记进 errors，不影响别的文件 */
async function scan(dir: string): Promise<{ detected: ProjectMcpDetected[]; errors: ProjectMcpOverview['errors'] }> {
  const detected: ProjectMcpDetected[] = []
  const errors: ProjectMcpOverview['errors'] = []
  for (const s of SOURCES) {
    const file = path.join(dir, s.file)
    if (!existsSync(file)) continue
    try {
      const text = await readFile(file, 'utf8')
      if (!text.trim()) continue
      if (s.store.format === 'toml') {
        for (const [name, server] of Object.entries(readToml(text, s.store))) {
          if (isPanelMcpUrl(server.url)) continue
          detected.push({
            name,
            server,
            file: s.file,
            source: s.source,
            status: 'new',
            raw: JSON.stringify(server, null, 2),
            nameOk: nameOk(name),
          })
        }
      } else {
        const root = JSON.parse(text)
        const table = root?.[s.store.key]
        if (!table || typeof table !== 'object' || Array.isArray(table)) continue
        for (const [name, server] of Object.entries(readServerTable(table, s.store))) {
          // 面板执行时临时写进来的自己的 MCP（agent-panel、以前的 panel-xxxx），不是用户的工具，不列出来
          if (isPanelMcpUrl(server.url)) continue
          detected.push({
            name,
            server,
            file: s.file,
            source: s.source,
            status: 'new',
            raw: JSON.stringify((table as Record<string, unknown>)[name], null, 2),
            nameOk: nameOk(name),
          })
        }
      }
    } catch (e) {
      errors.push({ file: s.file, error: (e as Error).message })
    }
  }
  return { detected, errors }
}

async function overview(dir: string): Promise<ProjectMcpOverview> {
  const global = await mcpOverview()
  const by = new Map(global.servers.map((s) => [s.name, s]))
  const { detected, errors } = dir ? await scan(dir) : { detected: [], errors: [] }
  for (const d of detected) {
    const cur = by.get(d.name)
    d.status = !cur ? 'new' : sameServer(d.server, cur) ? 'same' : 'different'
  }
  return { path: dir, clis: global.clis, servers: global.servers, detected, errors }
}

/** 项目目录从项目记录里取（server/index.ts 注入，不在这里另存一份） */
export function projectMcpApi(deps: { projectPath: (projectId: string) => Promise<string> }) {
  const guard = (fn: (c: any) => Promise<Response>) => async (c: any) => {
    try {
      return await fn(c)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  const parse = (v: unknown) => {
    const p = McpServer.safeParse(v)
    if (!p.success) throw new Error(t('工具名只能用字母、数字、- 和 _'))
    const sv = p.data
    if (sv.transport === 'stdio' && !sv.command.trim()) throw new Error(t('要填启动命令'))
    if (sv.transport === 'http' && !/^https?:\/\//.test(sv.url)) throw new Error(t('地址要以 http:// 或 https:// 开头'))
    return sv
  }
  const dirOf = async (c: any) => deps.projectPath(String(c.req.query('projectId') ?? ''))

  return (
    new Hono()
      .get(
        '/',
        guard(async (c) => c.json(await overview(await dirOf(c)))),
      )
      .post(
        '/test',
        guard(async (c) => c.json(await testMcp(parse(await c.req.json())))),
      )
      // 装到指定的 CLI 里，没选的 CLI 里同名的移除（和 mcp-tools 的 PUT 一致）
      .put(
        '/:name',
        guard(async (c) => {
          const body = await c.req.json()
          const sv = parse({ ...body.server, name: c.req.param('name') })
          const clis = (body.clis ?? []) as string[]
          const { clis: targets } = await mcpOverview()
          for (const t of targets) await (clis.includes(t.id) ? writeMcpTo(t.id, sv) : removeMcpFrom(t.id, sv.name))
          return c.json(await overview(await dirOf(c)))
        }),
      )
      .delete(
        '/:name',
        guard(async (c) => {
          for (const t of (await mcpOverview()).clis) await removeMcpFrom(t.id, c.req.param('name'))
          return c.json(await overview(await dirOf(c)))
        }),
      )
      // 一键导入：按「文件 + 名字」重新读一遍项目里的配置，再写进选中的 CLI
      .post(
        '/import',
        guard(async (c) => {
          const body = await c.req.json()
          const dir = await dirOf(c)
          const { detected } = dir ? await scan(dir) : { detected: [] }
          const { clis } = await mcpOverview()
          const result: ProjectMcpImportResult = {
            overview: await overview(dir),
            done: [],
            skipped: [],
          }
          for (const item of (body.items ?? []) as { file: string; name: string; clis?: string[] }[]) {
            const hit = detected.find((d) => d.file === item.file && d.name === item.name)
            if (!hit) {
              result.skipped.push({ name: item.name, file: item.file, reason: t('项目里已经没有这条配置了') })
              continue
            }
            const target = (item.clis?.length ? item.clis : clis.map((x) => x.id)).filter((id) =>
              clis.some((x) => x.id === id),
            )
            try {
              const sv = parse(hit.server)
              for (const id of target) await writeMcpTo(id, sv)
              result.done.push({ name: hit.name, file: hit.file })
            } catch (e) {
              result.skipped.push({ name: hit.name, file: hit.file, reason: (e as Error).message })
            }
          }
          result.overview = await overview(dir)
          return c.json(result)
        }),
      )
  )
}
