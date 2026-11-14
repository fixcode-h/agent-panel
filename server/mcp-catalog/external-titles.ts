/**
 * 别家 MCP 服务的工具显示名（shared/mcp-catalog/tool-titles.ts）：Agent 用到某个别家服务的工具时，
 * 按项目目录里的配置（.mcp.json 等）或各 CLI 全局配置找到这个服务，连上去问一遍 tools/list，
 * 把每个工具报的 title、_meta.titles 记进缓存，推给打开着的页面，对话里的工具行就显示「搜索 C++ 符号」而不是 search_symbols。
 *
 * 只在真用到时才问：这个服务 Agent 刚刚调用过，说明配置是用户自己装、CLI 已经在跑的，再起一份只是为了读工具表。
 * 同一个服务一天最多问一次（服务升级后新加的显示名第二天就能看到），碰到缓存里没有的工具时也会重问，但十分钟内不重复。
 */
import path from 'node:path'
import {
  McpToolTitles,
  setMcpToolTitles,
  mcpToolTitles,
  type McpToolTitle,
} from '../../shared/mcp-catalog/tool-titles.ts'
import { isOwnMcpServer } from '../../shared/tool-names.ts'
import { briefDesc } from '../../shared/mcp-catalog/code-index.ts'
import type { McpServer } from '../../shared/library.ts'
import { CACHE_DIR, readJson, writeJsonAtomic } from '../store.ts'
import { mcpOverview, testMcp } from '../mcp-store.ts'
import { scanProjectMcp } from '../projects/mcp.ts'
import { addPageFeed, signalPages } from '../page-events.ts'
import { log } from '../log.ts'
import { observeMcpTools } from '../exec/parsers.ts'

const FILE = path.join(CACHE_DIR, 'mcp-tool-titles.json')
const FRESH_MS = 24 * 3600_000
const RETRY_MS = 10 * 60_000

/** 缓存文件：每个服务问过的时间和结果；网页只拿 tools 那部分 */
interface Entry {
  at: number
  /** 问到的全部工具名：没起显示名的工具也记下，免得每次用到都当成新工具重问 */
  names: string[]
  tools: Record<string, McpToolTitle>
  /** 每个工具说明的第一句：认代码索引工具时写进提示词（code-index.ts），旧缓存没有这一项 */
  descs?: Record<string, string>
}
let entries: Record<string, Entry> | undefined // 模块状态：缓存副本，第一次用到时读缓存文件
const tried = new Map<string, number>() // 模块状态：会话，记每个服务上次去问的时间，免得一轮里反复起进程

async function load() {
  if (entries) return entries
  const raw = (await readJson(FILE)) as Record<string, Entry> | undefined
  entries = {}
  for (const [name, e] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const tools = McpToolTitles.safeParse({ x: e?.tools })
    if (tools.success && typeof e.at === 'number')
      entries[name] = {
        at: e.at,
        names: Array.isArray(e.names) ? e.names.map(String) : [],
        tools: tools.data.x,
        ...(e.descs && typeof e.descs === 'object' && { descs: e.descs }),
      }
  }
  publish(false)
  return entries
}

function publish(push: boolean) {
  const view = Object.fromEntries(Object.entries(entries ?? {}).map(([k, e]) => [k, e.tools]))
  setMcpToolTitles(view)
  if (push) signalPages({ type: 'mcp-titles', titles: view })
}

/** 按名字找服务的配置：先找项目目录里的（CLI 在这个目录里跑，项目配置优先），再找各 CLI 全局配置里的 */
async function findServer(name: string, cwd: string): Promise<McpServer | undefined> {
  const local = cwd ? (await scanProjectMcp(cwd).catch(() => ({ detected: [] }))).detected : []
  const hit = local.find((d) => d.name === name)
  if (hit) return hit.server
  return (await mcpOverview().catch(() => ({ servers: [] }))).servers.find((s) => s.name === name)
}

async function refresh(name: string, cwd: string, known?: McpServer) {
  const sv = known ?? (await findServer(name, cwd))
  if (!sv) return
  const r = await testMcp(sv, cwd || undefined)
  if (!r.ok) {
    log.warn('mcp', `问 MCP 服务 ${name} 的工具显示名失败`, { error: r.error })
    return
  }
  const tools: Record<string, McpToolTitle> = {}
  const descs: Record<string, string> = {}
  for (const x of r.tools) {
    if (x.shown) tools[x.name] = x.shown
    const d = briefDesc(x.description)
    if (d) descs[x.name] = d
  }
  const all = await load()
  all[name] = { at: Date.now(), names: r.tools.map((x) => x.name), tools, descs }
  publish(true)
  await writeJsonAtomic(FILE, all)
}

/**
 * CLI 输出里出现了一次 MCP 工具调用（server/exec/parsers.ts 的 parserFor 转过来）：
 * 别家服务、缓存里没有或过期了就在后台去问，不挡着解析
 */
export function noteMcpToolUse(server: string, tool: string, cwd: string) {
  if (!server || isOwnMcpServer(server)) return
  const e = entries?.[server]
  if (e && e.names.includes(tool) && Date.now() - e.at < FRESH_MS) return
  // 缓存还没读（服务刚启动）：读完再按缓存判断一次
  if (!entries) {
    void load().then(() => entries && noteMcpToolUse(server, tool, cwd))
    return
  }
  const last = tried.get(server) ?? 0
  if (Date.now() - last < RETRY_MS) return
  tried.set(server, Date.now())
  refresh(server, cwd).catch((err) => log.warn('mcp', `问 MCP 服务 ${server} 的工具显示名出错`, { error: String(err) }))
}

/** 缓存里这个服务的工具名和说明；没问过返回 undefined */
export async function externalToolsOf(server: string) {
  const e = (await load())[server]
  return e && { names: e.names, descs: e.descs ?? {}, fresh: Date.now() - e.at < FRESH_MS && !!e.descs }
}

/**
 * 项目里装的别家服务还没问过（或缓存过期、是没存说明的旧缓存）时主动去问一遍：
 * 代码索引工具要在 Agent 第一次搜索之前就写进提示词，不能等它用过一次。十分钟内同一个服务不重复问
 */
export async function askExternalTools(server: McpServer, cwd: string) {
  if (isOwnMcpServer(server.name)) return
  const last = tried.get(server.name) ?? 0
  if (Date.now() - last < RETRY_MS) return
  tried.set(server.name, Date.now())
  await refresh(server.name, cwd, server).catch((err) =>
    log.warn('mcp', `问 MCP 服务 ${server.name} 的工具表出错`, { error: String(err) }),
  )
}

/** 页面连上时先给一份完整的显示名表，之后有变化再推 */
export function installMcpToolTitles() {
  observeMcpTools(noteMcpToolUse)
  addPageFeed(async (send) => {
    await load()
    await send('mcp-titles', { type: 'mcp-titles', titles: mcpToolTitles() })
    return () => {}
  })
}
