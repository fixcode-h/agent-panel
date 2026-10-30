import type { McpServer } from './library.ts'
import { t } from './i18n.ts'

/**
 * 把用户粘贴的 MCP 配置 JSON 拆成面板表单能填的工具。
 * 各家文档给的写法不一样，这里都认：
 * - `{ "mcpServers": { 名字: 配置 } }`（Claude Code、Cursor、Claude Desktop），`servers`（VS Code）、`mcp.servers`、`context_servers`（Zed）
 * - 直接 `{ 名字: 配置 }`，或从文档里只复制了 `"名字": { ... }` 一段（没带外层花括号）
 * - 单个配置对象 `{ command, args, env }` / `{ type, url, headers }`，名字取它的 `name` 字段
 * 只在前端用，不碰文件；和服务端 server/mcp-store.ts 的 fromObject 读的字段保持一致。
 */

export type McpDraft = Omit<McpServer, 'name'> & { name: string }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 像不像一个工具的配置：有启动命令或远程地址 */
const looksLikeServer = (o: unknown): o is Record<string, any> =>
  isObj(o) && (typeof o.command === 'string' || typeof url(o) === 'string')

const url = (o: Record<string, any>) => o.url ?? o.serverUrl ?? o.httpUrl ?? o.uri

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x != null).map(String) : [])
const record = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x == null ? '' : String(x)])) : {}

/** 按空白拆命令行，认单双引号（`"command": "npx -y foo"` 这种把参数写进命令的） */
function splitCommand(s: string) {
  const out: string[] = []
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** VS Code 的 mcp.json 允许注释和结尾逗号；去掉再交给 JSON.parse（跳过字符串里的内容） */
function stripJsonc(s: string) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') {
      const start = i
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++
      out += s.slice(start, i + 1)
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

function parseLoose(text: string): unknown {
  const s = stripJsonc(text.trim()).trim()
  try {
    return JSON.parse(s)
  } catch (e) {
    // 只复制了 "名字": { ... } 一段，或多段之间带逗号：补上外层花括号再试
    if (s.startsWith('"')) {
      try {
        return JSON.parse(`{${s.replace(/,\s*$/, '')}}`)
      } catch {
        /* 报原来的错 */
      }
    }
    throw e
  }
}

function toDraft(name: string, o: Record<string, any>): McpDraft {
  const remote = url(o)
  const type = String(o.type ?? o.transport ?? '').toLowerCase()
  const stdio = typeof o.command === 'string' || (!remote && type !== 'http' && type !== 'sse')
  if (!stdio)
    return {
      name,
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: String(remote ?? ''),
      headers: record(o.headers ?? o.http_headers ?? o.requestInit?.headers),
    }
  let command = String(o.command ?? '').trim()
  let args = strings(o.args)
  // 参数写进了 command 里：拆开，表单里「启动命令」只放程序本身
  if (!args.length && /\s/.test(command)) [command = '', ...args] = splitCommand(command)
  return { name, transport: 'stdio', command, args, env: record(o.env), url: '', headers: {} }
}

/** 找出装工具的那张 { 名字: 配置 } 表 */
function serverTable(v: Record<string, any>): Record<string, any> | null {
  for (const k of ['mcpServers', 'servers', 'context_servers', 'mcp_servers']) if (isObj(v[k])) return v[k]
  if (isObj(v.mcp)) return serverTable(v.mcp)
  return null
}

/** 解析粘贴的 JSON；没认出任何工具时抛出给用户看的错误 */
export function parseMcpJson(text: string): McpDraft[] {
  if (!text.trim()) throw new Error(t('先粘贴 MCP 配置的 JSON'))
  let v: unknown
  try {
    v = parseLoose(text)
  } catch (e) {
    throw new Error(t('JSON 格式不对：{error}', { error: (e as Error).message }))
  }
  if (!isObj(v)) throw new Error(t('没在 JSON 里找到 MCP 工具的配置'))
  if (looksLikeServer(v)) return [toDraft(typeof v.name === 'string' ? v.name.trim() : '', v)]
  const table = serverTable(v) ?? v
  const out = Object.entries(table)
    .filter(([, o]) => looksLikeServer(o))
    .map(([name, o]) => toDraft(name, o))
  if (!out.length) throw new Error(t('没在 JSON 里找到 MCP 工具的配置'))
  return out
}
