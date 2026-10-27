import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CLIS } from '../shared/clis.ts'
import { isPanelMcpUrl, panelMcpToken } from '../shared/project-mcp.ts'
import { liveAskToken, lockedFile } from './ask-mcp.ts'

/**
 * 写配置文件接面板 MCP 的 CLI（Command Code 的 .mcp.json）会在用户项目里留下面板的条目。
 * 一轮正常结束时会删掉自己那一项，但面板被关掉、崩溃、被强制结束时来不及删，老版本还用过 panel、orch、panel-xxxxxx 这些名字，
 * 时间一长 .mcp.json 里就堆了几十条指向早已失效地址的「panel-xxxx」。这里负责：
 * - 名字：同一个目录里第一轮固定叫 agent-panel，只有同时在跑的另几轮才带后缀，平时项目里最多一项
 * - 清理：写之前、面板启动时把这个目录里不再有效的面板条目（地址指向本面板、令牌已经不在）连同权限放行一起删掉
 */

export const PANEL_MCP_NAME = 'agent-panel'

/** 面板各个版本写进项目的名字：agent-panel、agent-panel-xxxxxx，以及老版本的 panel、panel-xxxxxx、orch */
const PANEL_NAME = /^(agent-panel(-[0-9a-f]{6})?|panel(-[0-9a-f]{6})?|orch)$/

/** 每个目录里正在用的名字：同时在跑的几轮各用一个，不然后写的会把先写的那一项冲掉 */
const claimed = new Map<string, Set<string>>()

/** 给这一轮在 cwd 里取一个面板 MCP 的名字；用完 release */
export function claimPanelName(cwd: string, suffix: string) {
  const key = path.resolve(cwd)
  const used = claimed.get(key) ?? new Set<string>()
  claimed.set(key, used)
  const name = used.has(PANEL_MCP_NAME) ? `${PANEL_MCP_NAME}-${suffix}` : PANEL_MCP_NAME
  used.add(name)
  return {
    name,
    release: () => {
      used.delete(name)
      if (!used.size) claimed.delete(key)
    },
  }
}

/** CLI 定义里写进项目目录的配置文件（{dir} 开头的放在面板自己的临时目录，不用管） */
export function panelConfigFiles() {
  const files = new Set<string>()
  for (const c of CLIS)
    for (const f of Object.keys(c.mcp?.files ?? {}))
      if (!f.includes('{') && !path.isAbsolute(f) && !f.startsWith('~')) files.add(f)
  return [...files]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 从一份配置里删掉失效的面板条目，返回删完的内容；没有可删的返回 undefined。
 * 只认指向本面板端口的地址：别的端口上可能是另一个正在跑的面板，不动它的
 */
export function stripStalePanelMcp(
  root: unknown,
  o: { port: number; live: (token: string) => boolean; inUse: Set<string> },
) {
  if (!isObj(root)) return undefined
  const out = structuredClone(root)
  const removed = new Set<string>()
  for (const key of ['mcpServers', 'servers']) {
    const table = out[key]
    if (!isObj(table)) continue
    const before = removed.size
    for (const [name, entry] of Object.entries(table)) {
      const url = isObj(entry) ? (entry.url ?? entry.httpUrl) : undefined
      if (!isPanelMcpUrl(url, o.port)) continue
      const token = panelMcpToken(String(url))
      if (token && o.live(token)) continue
      delete table[name]
      removed.add(name)
    }
    if (!Object.keys(table).length && removed.size > before) delete out[key]
  }
  // 权限放行（Command Code 的 .commandcode/settings.json）：删掉的条目、以及面板以前用过、现在没在用的名字
  const perms = out.permissions
  let pruned = false
  if (isObj(perms) && Array.isArray(perms.allow)) {
    const keep = perms.allow.filter((x) => {
      const m = typeof x === 'string' ? /^mcp__(.+)__\*$/.exec(x) : null
      if (!m) return true
      return !(removed.has(m[1]) || (PANEL_NAME.test(m[1]) && !o.inUse.has(m[1])))
    })
    if (keep.length !== perms.allow.length) {
      pruned = true
      if (keep.length) perms.allow = keep
      else delete perms.allow
      if (!Object.keys(perms).length) delete out.permissions
    }
  }
  return removed.size || pruned ? out : undefined
}

/** 清掉 cwd 里面板留下的失效条目；文件因此变空就删掉（这种文件本来就是面板建的）。出错只跳过，不影响执行 */
export async function sweepPanelMcp(cwd: string) {
  const port = Number(process.env.PORT ?? 8787)
  const inUse = claimed.get(path.resolve(cwd)) ?? new Set<string>()
  let cleaned = 0
  for (const rel of panelConfigFiles()) {
    const file = path.resolve(cwd, rel)
    if (!existsSync(file)) continue
    await lockedFile(file, async () => {
      let root: unknown
      try {
        root = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        return
      }
      const out = stripStalePanelMcp(root, { port, live: liveAskToken, inUse })
      if (!out) return
      cleaned++
      if (!Object.keys(out).length) await rm(file, { force: true })
      else await writeFile(file, JSON.stringify(out, null, 2))
    }).catch(() => {})
  }
  return cleaned
}
