/**
 * 能力路由能用的别家 MCP 服务：面板自己当客户端去调，所以不看这一轮的 CLI 挂没挂（Codex、Pi 没装 IDEA 也能走 lua_code）。
 *
 * 从哪里找（设计稿第 1 节的第 1、2 条就是以前漏在这里）：
 * - 工作目录和项目目录往上几层的项目配置（.mcp.json 等）：EmmyLua 把配置装在版本管理根，常在 UE 项目上一层；
 * - 各 CLI 的全局配置和面板库里的服务（IDEA 自动配置写的是全局）。
 * 工具表用缓存（external-titles.ts），缓存没有或过期就去问，第一次最多等 WAIT_MS，等不到这一次先当没有、问完下次就有
 */
import path from 'node:path'
import type { McpServer } from '../../shared/library.ts'
import { isOwnMcpServer } from '../../shared/tool-names.ts'
import { scanProjectMcp } from '../projects/mcp.ts'
import { mcpOverview } from '../mcp-store.ts'
import { askExternalTools, externalToolsOf } from '../mcp-catalog/external-titles.ts'

const WAIT_MS = 4000
/** 往上找项目配置最多几层：P4 工作区根、git 仓库根一般就在一两层之上 */
const UP_LEVELS = 4

export interface RouteServer {
  name: string
  server: McpServer
  /** 起 stdio 服务用的目录：项目配置在哪就在哪（配置里常写相对路径，例如 UEToVS 的 --solution-dir .） */
  cwd: string
  /** 工具表里的名字；还没问到时为空 */
  tools: string[]
}

function upDirs(dirs: string[]): string[] {
  const out: string[] = []
  for (const d of dirs) {
    let cur = path.resolve(d)
    for (let i = 0; i <= UP_LEVELS; i++) {
      if (!out.includes(cur)) out.push(cur)
      const up = path.dirname(cur)
      if (up === cur) break
      cur = up
    }
  }
  return out
}

const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.())

/** 这个项目这一轮能用的别家服务和它们的工具；dirs 是工作目录、项目目录（独立分支时两个不同） */
export async function routeServers(dirs: string[]): Promise<RouteServer[]> {
  const byName = new Map<string, { server: McpServer; cwd: string }>()
  const global = (await mcpOverview().catch(() => ({ servers: [] }))).servers
  for (const s of global) byName.set(s.name, { server: s, cwd: dirs[0] ?? process.cwd() })
  // 项目配置优先（离工作目录越近越优先）：同名的以它为准
  for (const d of upDirs(dirs).reverse()) {
    const found = (await scanProjectMcp(d).catch(() => ({ detected: [] }))).detected
    for (const x of found) byName.set(x.name, { server: x.server, cwd: d })
  }
  const list = [...byName.entries()].filter(([name]) => !isOwnMcpServer(name))
  const asks: Promise<void>[] = []
  for (const [name, x] of list) if (!(await externalToolsOf(name))?.fresh) asks.push(askExternalTools(x.server, x.cwd))
  if (asks.length) await Promise.race([Promise.all(asks), timeout(WAIT_MS)])
  const out: RouteServer[] = []
  for (const [name, x] of list)
    out.push({ name, server: x.server, cwd: x.cwd, tools: (await externalToolsOf(name))?.names ?? [] })
  return out
}
