import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { McpStore } from '../../shared/cli-spec.ts'
import { McpServer } from '../../shared/library.ts'
import { t } from '../../shared/i18n.ts'
import {
  isPanelMcpUrl,
  type ProjectMcpDetected,
  type ProjectMcpImportResult,
  type ProjectMcpOverview,
} from '../../shared/projects/mcp.ts'
import {
  activationOf,
  agentProjectServers,
  deleteMcpEntry,
  mcpOverview,
  previousOf,
  readServerTable,
  readToml,
  saveMcpEntry,
  testMcp,
} from '../mcp-store.ts'
import { sameServer } from '../../shared/mcp-library/inject.ts'
import { scanMcpServer } from '../../shared/config-scan/index.ts'
import { visibleFindings } from '../config-scan.ts'
import { autoImportProjectMcp, markSeen } from './mcp-auto.ts'

/**
 * 项目设置里的「MCP」：列出这个项目的目录里各工具认的 MCP 配置，可以一键导入成面板管理的配置。
 *
 * 只读用户的文件。导入成「按项目」的条目（面板库，见 mcp-store 的 saveMcpEntry）并在这个项目里打开；
 * 同名的全局条目已经存在时照旧更新全局那份。项目里的配置文件原文一直留在用户自己手里，所以不需要备份、也不会被改坏。
 * 项目目录里的配置读到时自动导入、打开（./mcp-auto.ts）；Agent 自己配置里只对这个项目生效的那份只列为可导入。
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

const nameOk = (name: string) => /^[A-Za-z0-9][\w-]*$/.test(name)

/** 读项目目录里的配置文件；读不懂的一个只记进 errors，不影响别的文件 */
export async function scanProjectMcp(
  dir: string,
): Promise<{ detected: ProjectMcpDetected[]; errors: ProjectMcpOverview['errors'] }> {
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
  for (const a of await agentProjectServers(dir)) {
    for (const [name, server] of Object.entries(a.servers)) {
      if (isPanelMcpUrl(server.url)) continue
      detected.push({
        name,
        server,
        file: a.file,
        source: t('{cli} 里只对本项目生效的配置', { cli: a.cli }),
        status: 'new',
        raw: JSON.stringify(a.raw[name], null, 2),
        nameOk: nameOk(name),
        fromAgent: true,
      })
    }
  }
  return { detected, errors }
}

async function overview(dir: string): Promise<ProjectMcpOverview> {
  const global = await mcpOverview()
  const by = new Map(global.servers.map((s) => [s.name, s]))
  const { detected, errors } = dir ? await scanProjectMcp(dir) : { detected: [], errors: [] }
  for (const d of detected) {
    const cur = by.get(d.name)
    d.status = !cur ? 'new' : sameServer(d.server, cur) ? 'same' : 'different'
    // 配置安全扫描：导入就会写进各 CLI 的全局配置，之后所有项目都会启动它，导入前把风险标出来
    const scope = `mcp:${path.resolve(dir)}`
    const found = await visibleFindings(scanMcpServer(`${d.file}#${d.name}`, d.server, d.raw), scope)
    if (found.length) Object.assign(d, { scan: found, scanScope: scope })
  }
  return { path: dir, clis: global.clis, servers: global.servers, detected, errors }
}

/**
 * 项目目录从项目记录里取，打开能力也在项目记录上改（server/index.ts 注入，不在这里另存一份）。
 * enableMcp 把名字加进项目的 capabilities.mcp
 */
export function projectMcpApi(deps: {
  projectPath: (projectId: string) => Promise<string>
  enableMcp: (projectId: string, names: string[]) => Promise<void>
}) {
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
      // 读的时候顺带自动导入项目目录里新出现的配置（打开项目、进项目 MCP 页都会读这里）
      .get(
        '/',
        guard(async (c) => {
          const id = String(c.req.query('projectId') ?? '')
          const dir = await deps.projectPath(id)
          const auto = dir
            ? await autoImportProjectMcp(id, (await scanProjectMcp(dir)).detected, deps.enableMcp)
            : { enabled: [] }
          const o = await overview(dir)
          return c.json(auto.enabled.length ? { ...o, autoEnabled: auto.enabled } : o)
        }),
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
          await saveMcpEntry(sv, body.clis ?? [], activationOf(body.activation), previousOf(body.previous))
          return c.json(await overview(await dirOf(c)))
        }),
      )
      .delete(
        '/:name',
        guard(async (c) => {
          await deleteMcpEntry(c.req.param('name'))
          return c.json(await overview(await dirOf(c)))
        }),
      )
      // 一键导入：按「文件 + 名字」重新读一遍项目里的配置，再写进选中的 CLI
      .post(
        '/import',
        guard(async (c) => {
          const body = await c.req.json()
          const projectId = String(c.req.query('projectId') ?? '')
          const dir = await dirOf(c)
          const { detected } = dir ? await scanProjectMcp(dir) : { detected: [] }
          const { clis } = await mcpOverview()
          const result: ProjectMcpImportResult = {
            overview: await overview(dir),
            done: [],
            skipped: [],
          }
          for (const item of (body.items ?? []) as {
            file: string
            name: string
            clis?: string[]
            toProject?: boolean
          }[]) {
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
              // 导入是「加上」：已经装着的 CLI 保留；已有的条目生效方式照原来的，新的条目按项目、在这个项目里打开。
              // toProject：项目里也有、却装成了全局的（老版本导入或别的工具写进各 Agent 全局配置的），用户点「改为只在本项目」
              // 时改成按项目、从全局配置里移走，并在这个项目打开（用户 2026-11-17：项目导入的不应该是全局）
              const had = (await mcpOverview()).servers.find((x) => x.name === sv.name)
              const act = item.toProject ? 'project' : (had?.activation ?? 'project')
              await saveMcpEntry(sv, [...new Set([...(had?.clis ?? []), ...target])], act)
              if (act !== 'global') await deps.enableMcp(projectId, [sv.name])
              await markSeen(projectId, [sv.name])
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
