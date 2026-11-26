/**
 * 这一轮 CLI 自己会挂哪些外部 MCP 服务（ADR 0085）：代理要接管的就是这一份，不多也不少——
 * CLI 只挂面板之后，这里漏一个 Agent 就少一个服务的工具。
 *
 * 按 CLI 自己读配置的地方收：全局配置里装给这个 CLI 的、CLI 存在全局配置里只对这个目录生效的（Claude Code 的 local scope）、
 * 项目目录里 CLI 自己读的文件（CLI 定义的 mcpProbe.files，例如 .mcp.json），再加面板库里按项目打开的条目（以前按 mcpStore.inject 每轮带上的）。
 * 同名的后面的为准（和 CLI 自己的优先级一样：按项目 > 本目录 > 全局）。面板自己和插件的服务不算外部服务
 */
import type { CliDefinition } from '../../shared/clis.ts'
import { McpServer } from '../../shared/library.ts'
import { isOwnMcpServer } from '../../shared/tool-names.ts'
import type { LibraryEntry } from '../mcp-library/file.ts'
import { agentProjectServers, mcpOverview } from '../mcp-store.ts'
import { scanProjectMcp } from '../projects/mcp.ts'

export interface ProxyCandidate {
  name: string
  /** 从哪读到的，给人看（设置页「给 Agent 的工具」） */
  source: string
  server: McpServer
  /** 起 stdio 服务用的目录 */
  cwd: string
  /** 面板库里按项目打开的条目：退回直接挂时本来就按 inject 带上 */
  library?: boolean
}

export async function proxyCandidates(
  def: CliDefinition,
  cwd: string,
  projectMcp: LibraryEntry[] | undefined,
  taken: string[],
): Promise<ProxyCandidate[]> {
  const by = new Map<string, ProxyCandidate>()
  const put = (c: ProxyCandidate) => {
    if (isOwnMcpServer(c.name) || taken.includes(c.name)) return
    by.set(c.name, c)
  }
  const overview = await mcpOverview().catch(() => ({ servers: [] }))
  for (const e of overview.servers) {
    if ((e.activation ?? 'global') !== 'global' || !e.clis.includes(def.id)) continue
    const sv = McpServer.safeParse(e)
    if (sv.success) put({ name: e.name, source: def.mcpStore?.file ?? 'global', server: sv.data, cwd })
  }
  for (const x of await agentProjectServers(cwd).catch(() => []))
    if (x.cli === def.name)
      for (const sv of Object.values(x.servers)) put({ name: sv.name, source: x.file, server: sv, cwd })
  const files = def.mcpProbe?.files ?? []
  if (files.length)
    for (const d of (await scanProjectMcp(cwd).catch(() => ({ detected: [] }))).detected)
      if (files.includes(d.file)) put({ name: d.name, source: d.file, server: d.server, cwd })
  for (const e of projectMcp ?? [])
    if (e.clis.includes(def.id)) put({ name: e.server.name, source: 'library', server: e.server, cwd, library: true })
  return [...by.values()]
}
