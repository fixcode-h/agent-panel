/**
 * JetBrains IDE 的 MCP 服务「定不了项目」时，按面板当前项目从 IDE 已开的项目里挑出该传的 projectPath。
 *
 * 为什么要有：IDE 的 MCP 服务器在调任何工具（包括插件的 lua_code）之前先定项目——调用里的 projectPath、
 * 配置里的请求头 IJ_MCP_SERVER_PROJECT_PATH、客户端报的 roots 都没有时，只开一个项目就用它，开了多个就直接报
 * 「Unable to determine the target project」，工具本身跑不到（用户 2026-11-23 报 lua_code 因此失败）。
 * 报错末尾带着 `Currently open projects: {"projects":[{"path":"..."}]}`（IDE 源码 McpCallInfo.noSuitableProjectError），
 * 面板拿它和这一轮的工作目录比，挑出对的那个告诉 Agent，不让它自己猜、也不让它原样重试。
 */

/** IDE 报「定不了项目」的两种开头：没传路径（开了多个项目）、传的路径不在任何打开的项目里 */
const NO_PROJECT = /Unable to determine the target project|doesn't correspond to any open project/

/** 从 IDE 的报错里取已开项目的路径；不是这类报错返回 undefined */
export function openProjectsIn(output: string): string[] | undefined {
  if (!NO_PROJECT.test(output)) return undefined
  const at = output.indexOf('Currently open projects:')
  if (at < 0) return []
  const rest = output.slice(at + 'Currently open projects:'.length)
  const start = rest.indexOf('{')
  if (start < 0) return []
  // JSON 后面可能还接着 CLI 自己加的字（截断提示等）：从第一个 { 起按括号配对取完整的一段
  let depth = 0
  let inStr = false
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        const list = (JSON.parse(rest.slice(start, i + 1)) as { projects?: { path?: unknown }[] }).projects ?? []
        return list.map((p) => p.path).filter((p): p is string => typeof p === 'string' && !!p)
      } catch {
        return []
      }
    }
  }
  return []
}

/** 比路径用的形式：斜杠统一、去掉结尾斜杠；带盘符的（Windows）不分大小写 */
const norm = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s
}
/** 两个路径是不是同一个目录（斜杠、结尾斜杠、Windows 盘符大小写不算差别） */
export const samePath = (a: string, b: string) => norm(a) === norm(b)
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + '/')

export interface IdeProjectPick {
  /** 挑中的 IDE 项目路径（IDE 报的原样写法）；挑不出来时没有 */
  path?: string
  /** 挑不出来时可选的几个（工作目录下有多个 IDE 项目时只列这几个，否则列全部） */
  candidates: string[]
}

/**
 * 按面板这一轮的工作目录挑：
 * 1. 工作目录在某个 IDE 项目里面（含相等）：取最深的那个；
 * 2. 否则工作目录下面只有一个 IDE 项目（常见：工作目录是 P4 工作区根，IDE 打开的是它下面的 Project 子目录）：取它；
 * 3. 下面有多个、或一个都对不上：挑不出来，交给用户选。
 */
export function pickIdeProject(open: string[], dirs: string[]): IdeProjectPick {
  const wanted = [...new Set(dirs.filter(Boolean).map(norm))]
  const all = open.map((p) => ({ raw: p, n: norm(p) }))
  for (const d of wanted) {
    const outer = all.filter((p) => within(d, p.n)).sort((a, b) => b.n.length - a.n.length)
    if (outer[0]) return { path: outer[0].raw, candidates: [] }
  }
  for (const d of wanted) {
    const inner = all.filter((p) => within(p.n, d))
    if (inner.length === 1) return { path: inner[0].raw, candidates: [] }
    if (inner.length > 1) return { candidates: inner.map((p) => p.raw) }
  }
  return { candidates: open }
}
