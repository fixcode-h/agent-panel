import type { McpStore } from '../cli-spec.ts'
import type { McpServer } from '../library.ts'

/**
 * 全局 MCP 库的条目（设计稿 Agent侧栏与项目管理重设计 6.2）：
 * - global：写进各 CLI 自己的全局配置（mcpStore.file），所有项目都加载，和以前一样；
 * - project：面板自己存一份（数据目录 config/mcp-library.json），只在 capabilities.mcp 里打开了它的项目里，
 *   每轮按 CLI 定义的 mcpStore.inject 带上。CLI 没写 inject 时退回全局写入（界面注明）。
 */
export type McpActivation = 'global' | 'project'

/**
 * 一个条目写成 CLI 配置里的对象：写全局配置和每轮注入共用这一份，字段名、type 都按 CLI 定义的 mcpStore 走。
 * old 是配置里原有的对象：保留别的字段，只换掉面板管的这几个
 */
export function mcpServerObject(sv: McpServer, s: McpStore, old: Record<string, any> = {}) {
  const o = { ...old }
  for (const k of ['type', 'command', 'args', 'env', 'url', 'httpUrl', 'headers', 'http_headers']) delete o[k]
  if (sv.transport === 'stdio') {
    if (s.stdioType) o.type = 'stdio'
    o.command = sv.command
    if (sv.args.length) o.args = sv.args
    if (Object.keys(sv.env).length) o.env = sv.env
  } else {
    if (s.remoteType) o.type = s.remoteType
    o[s.urlKey] = sv.url
    if (Object.keys(sv.headers).length) o[s.headersKey] = sv.headers
  }
  return o
}

const tomlKey = (k: string) => (/^[\w-]+$/.test(k) ? k : JSON.stringify(k))

/** TOML 的值：字符串用 JSON 的双引号写法（TOML 基本字符串的转义和它一致），数组、内联表递归 */
function tomlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`
  if (v && typeof v === 'object')
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
      .join(', ')} }`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(String(v ?? ''))
}

/**
 * 这一轮要带的「按项目」条目换成 CLI 参数。CLI 没写 inject 或没有条目时返回空数组。
 * 参数里不会有换行（JSON.stringify 会转义），Windows 上经 cmd 传也不会被截断
 */
export function mcpInjectArgs(s: McpStore | undefined, servers: McpServer[]): string[] {
  const inj = s?.inject
  if (!inj || !servers.length) return []
  if (inj.format === 'json') {
    const json = JSON.stringify({
      [s.key]: Object.fromEntries(servers.map((sv) => [sv.name, mcpServerObject(sv, s)])),
    })
    return inj.args.map((a) => a.replace('{json}', () => json))
  }
  const out: string[] = []
  for (const sv of servers)
    for (const [field, value] of Object.entries(mcpServerObject(sv, s))) {
      const key = `${s.key}.${tomlKey(sv.name)}.${tomlKey(field)}`
      const val = tomlValue(value)
      out.push(...inj.args.map((a) => a.replace('{key}', () => key).replace('{value}', () => val)))
    }
  return out
}

/** 配置内容是否一样（不算名字和装在哪几个 CLI） */
export function sameServer(a: McpServer, b: McpServer) {
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
