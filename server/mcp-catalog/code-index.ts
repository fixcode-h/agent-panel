/**
 * 认出一个项目能用的代码索引 MCP 工具（规则和提示词写法在 shared/mcp-catalog/code-index.ts），每轮建 host 时调一次。
 *
 * - 项目设置里手动指定了（codeIndexTools）就只用指定的；
 * - 否则看项目目录里的 MCP 配置（.mcp.json 等，CLI 在项目里跑会装上）和各 CLI 全局配置里的服务：
 *   工具表从 external-titles 的缓存取；项目里的服务没问过就主动去问，最多等 WAIT_MS，
 *   超时就先按没有处理、后台问完写进缓存，下一轮就带上。全局服务只用缓存（用过一次才有），
 *   免得每个项目都把全局装的所有服务起一遍。
 */
import type { Project } from '../../shared/schema.ts'
import { isOwnMcpServer } from '../../shared/tool-names.ts'
import { isCodeIndexTool, parseCodeIndexItem, type CodeIndexTool } from '../../shared/mcp-catalog/code-index.ts'
import { scanProjectMcp } from '../projects/mcp.ts'
import { mcpOverview } from '../mcp-store.ts'
import { askExternalTools, externalToolsOf } from './external-titles.ts'

const WAIT_MS = 4000

const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.())

export async function codeIndexToolsFor(
  project: Pick<Project, 'path' | 'codeIndexTools'> | undefined,
  cwd: string,
): Promise<CodeIndexTool[]> {
  if (!project) return []
  const pinned = (project.codeIndexTools ?? []).map(parseCodeIndexItem).filter((x) => !!x)
  if (pinned.length) {
    const out: CodeIndexTool[] = []
    for (const p of pinned) out.push({ ...p, desc: (await externalToolsOf(p.server))?.descs[p.tool] })
    return out
  }
  const local = (await scanProjectMcp(cwd || project.path).catch(() => ({ detected: [] }))).detected
  const global = (await mcpOverview().catch(() => ({ servers: [] }))).servers
  const servers = new Map<string, { local: boolean; server: (typeof local)[number]['server'] }>()
  for (const s of global) servers.set(s.name, { local: false, server: s })
  // 项目里的配置优先（CLI 在项目目录里跑时用的就是它）
  for (const d of local) servers.set(d.name, { local: true, server: d.server })

  const stale = [...servers.entries()].filter(([name]) => !isOwnMcpServer(name))
  const asks: Promise<void>[] = []
  for (const [name, s] of stale) {
    if (!s.local) continue
    const known = await externalToolsOf(name)
    if (!known?.fresh) asks.push(askExternalTools(s.server, cwd || project.path))
  }
  if (asks.length) await Promise.race([Promise.all(asks), timeout(WAIT_MS)])

  const out: CodeIndexTool[] = []
  for (const [name] of stale) {
    const known = await externalToolsOf(name)
    if (!known) continue
    for (const tool of known.names)
      if (isCodeIndexTool(tool)) out.push({ server: name, tool, ...(known.descs[tool] && { desc: known.descs[tool] }) })
  }
  return out
}
