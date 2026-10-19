import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS, type CliDefinition } from '../shared/clis.ts'
import type { McpStore } from '../shared/cli-spec.ts'
import { McpServer, type McpEntry, type McpOverview, type McpTestResult } from '../shared/library.ts'
import { t } from '../shared/i18n.ts'
import { expandHome } from './cli-extras.ts'
import { childEnv, runProcess } from './exec/process.ts'
import { writeJsonAtomic } from './store.ts'

/**
 * 用户自己装的 MCP 工具：直接读写各 CLI 自己的配置文件（定义里的 mcpStore），装在哪个 CLI 里就在哪个文件里。
 * 面板不另存一份，这样用 CLI 自己的命令（claude mcp add 等）改过的也能看到。
 */

type Def = CliDefinition & { mcpStore: McpStore }
const managed = (): Def[] => CLIS.filter((d): d is Def => !!d.mcpStore)
const fileOf = (d: Def) => expandHome(d.mcpStore.file)

// ---- TOML：只处理 [mcp_servers.名字] 这几段，文件里别的内容原样保留 ----

type Val = string | number | boolean | Val[] | { [k: string]: Val }

/** 解析 TOML 的值（字符串、数字、布尔、数组、内联表）；返回值和读到的位置 */
function tomlValue(s: string, i = 0): [Val, number] {
  const ws = () => {
    while (i < s.length && /[\s,]/.test(s[i])) i++
  }
  ws()
  const c = s[i]
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
    const q = s.slice(i, i + 3)
    const end = s.indexOf(q, i + 3)
    const raw = s.slice(i + 3, end < 0 ? s.length : end).replace(/^\r?\n/, '')
    return [q === '"""' ? unescapeToml(raw) : raw, (end < 0 ? s.length : end) + 3]
  }
  if (c === '"') {
    let j = i + 1
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
    return [unescapeToml(s.slice(i + 1, j)), j + 1]
  }
  if (c === "'") {
    const end = s.indexOf("'", i + 1)
    return [s.slice(i + 1, end < 0 ? s.length : end), (end < 0 ? s.length : end) + 1]
  }
  if (c === '[') {
    const out: Val[] = []
    i++
    for (;;) {
      ws()
      if (i >= s.length || s[i] === ']') return [out, i + 1]
      if (s[i] === '#') {
        while (i < s.length && s[i] !== '\n') i++
        continue
      }
      const [v, n] = tomlValue(s, i)
      out.push(v)
      i = n
    }
  }
  if (c === '{') {
    const out: Record<string, Val> = {}
    i++
    for (;;) {
      ws()
      if (i >= s.length || s[i] === '}') return [out, i + 1]
      const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)\s*=\s*/.exec(s.slice(i))
      if (!m) return [out, s.length]
      i += m[0].length
      const [v, n] = tomlValue(s, i)
      out[unquoteKey(m[1])] = v
      i = n
    }
  }
  const m = /^[^\s,\]}#]+/.exec(s.slice(i))
  const raw = m?.[0] ?? ''
  const v: Val = raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(Number(raw)) ? raw : Number(raw)
  return [v, i + raw.length]
}

const unescapeToml = (v: string) =>
  v.replace(/\\(u[0-9a-fA-F]{4}|["\\nrt]|\r?\n\s*)/g, (_, c: string) =>
    c[0] === 'u'
      ? String.fromCharCode(parseInt(c.slice(1), 16))
      : (({ n: '\n', r: '\r', t: '\t' } as any)[c] ?? (c.length > 1 ? '' : c)),
  )

function unquoteKey(k: string) {
  if (k.startsWith('"')) return unescapeToml(k.slice(1, -1))
  if (k.startsWith("'")) return k.slice(1, -1)
  return k
}

/** 表头 [a.b."c d"] 拆成各段 */
function headerParts(h: string) {
  const out: string[] = []
  const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^.\s"']+)\s*(?:\.|$)/y
  for (let m; (m = re.exec(h)) && m[0]; ) out.push(unquoteKey(m[1]))
  return out
}

interface Section {
  parts: string[]
  /** 表头所在行和结束行（不含） */
  from: number
  to: number
}

function tomlSections(lines: string[]): Section[] {
  const out: Section[] = []
  lines.forEach((l, i) => {
    const m = /^\s*\[(?!\[)(.+?)\]\s*(?:#.*)?$/.exec(l)
    if (!m) return
    if (out.length) out.at(-1)!.to = i
    out.push({ parts: headerParts(m[1]), from: i, to: lines.length })
  })
  return out
}

/** 一段里的键值（多行数组、多行字符串按整体读） */
function tomlBody(lines: string[]): Record<string, Val> {
  const text = lines.join('\n')
  const out: Record<string, Val> = {}
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const m = /^\s*(?:#[^\n]*\n|("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)\s*=\s*)/.exec(rest)
    if (!m) break
    i += m[0].length
    if (!m[1]) continue
    const [v, n] = tomlValue(text, i)
    out[unquoteKey(m[1])] = v
    i = n
  }
  return out
}

/** 整个 TOML 文件读成对象：[a.b] 表头按段嵌套（[[数组表]] 不处理），给识别 CLI 配置用 */
export function parseToml(text: string): Record<string, Val> {
  const lines = text.split(/\r?\n/)
  const secs = tomlSections(lines)
  const root = tomlBody(lines.slice(0, secs[0]?.from ?? lines.length))
  for (const sec of secs) {
    let cur: Record<string, Val> = root
    for (const k of sec.parts) {
      const next = cur[k]
      cur = (next && typeof next === 'object' && !Array.isArray(next) ? next : (cur[k] = {})) as Record<string, Val>
    }
    Object.assign(cur, tomlBody(lines.slice(sec.from + 1, sec.to)))
  }
  return root
}

const asStrings = (v: Val | undefined) => (Array.isArray(v) ? v.map(String) : [])
const asRecord = (v: Val | undefined): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]))
    : {}

export function readToml(text: string, s: McpStore): Record<string, McpServer> {
  const lines = text.split(/\r?\n/)
  const secs = tomlSections(lines).filter((x) => x.parts[0] === s.key && x.parts.length >= 2)
  const byName = new Map<string, Record<string, Val>>()
  for (const sec of secs) {
    const cur = byName.get(sec.parts[1]) ?? {}
    const body = tomlBody(lines.slice(sec.from + 1, sec.to))
    if (sec.parts.length === 2) Object.assign(cur, body)
    else if (sec.parts.length === 3) cur[sec.parts[2]] = body
    byName.set(sec.parts[1], cur)
  }
  const out: Record<string, McpServer> = {}
  for (const [name, o] of byName) out[name] = fromObject(name, o, s)
  return out
}

const q = (v: string) => JSON.stringify(v)
const tomlKey = (k: string) => (/^[\w-]+$/.test(k) ? k : q(k))

function tomlBlock(sv: McpServer, s: McpStore) {
  const head = `[${s.key}.${tomlKey(sv.name)}]`
  const lines = [head]
  const table = (name: string, rec: Record<string, string>) =>
    Object.keys(rec).length
      ? [
          '',
          `[${s.key}.${tomlKey(sv.name)}.${name}]`,
          ...Object.entries(rec).map(([k, v]) => `${tomlKey(k)} = ${q(v)}`),
        ]
      : []
  if (sv.transport === 'stdio') {
    lines.push(`command = ${q(sv.command)}`)
    if (sv.args.length) lines.push(`args = [${sv.args.map(q).join(', ')}]`)
    lines.push(...table('env', sv.env))
  } else {
    lines.push(`${s.urlKey} = ${q(sv.url)}`)
    lines.push(...table(s.headersKey, sv.headers))
  }
  return lines.join('\n')
}

export function writeToml(text: string, s: McpStore, sv: McpServer | null, name: string) {
  const lines = text.split(/\r?\n/)
  const drop = new Set<number>()
  for (const sec of tomlSections(lines))
    if (sec.parts[0] === s.key && sec.parts[1] === name) for (let i = sec.from; i < sec.to; i++) drop.add(i)
  let kept = lines
    .filter((_, i) => !drop.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  if (sv) kept += `${kept ? '\n\n' : ''}${tomlBlock(sv, s)}`
  return kept + '\n'
}

// ---- JSON ----

function fromObject(name: string, o: Record<string, any>, s: McpStore): McpServer {
  const url = String(o[s.urlKey] ?? o.url ?? o.httpUrl ?? '')
  const stdio = !!o.command || !url
  // 读别人写的配置，名字不卡格式（只有面板自己新建时才限制）
  return {
    name,
    ...McpServer.omit({ name: true }).parse({
      transport: stdio ? 'stdio' : 'http',
      command: stdio ? String(o.command ?? '') : '',
      args: stdio ? asStrings(o.args) : [],
      env: stdio ? asRecord(o.env) : {},
      url: stdio ? '' : url,
      headers: stdio ? {} : asRecord(o[s.headersKey] ?? o.headers ?? o.http_headers),
    }),
  }
}

function toObject(sv: McpServer, s: McpStore, old: Record<string, any> = {}) {
  // 保留别的字段（例如 Gemini CLI 的 trust），只换掉面板管的这几个
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

async function readText(file: string) {
  return existsSync(file) ? await readFile(file, 'utf8') : ''
}

async function readJsonFile(file: string): Promise<Record<string, any>> {
  const text = await readText(file)
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch {}
  // 读不懂就不动它：写回去会把用户的其他配置弄丢
  throw new Error(t('{file} 不是有效的 JSON，没有改动', { file }))
}

/** 一个 CLI 里装的全部 MCP 工具 */
async function readServers(d: Def): Promise<Record<string, McpServer>> {
  const s = d.mcpStore
  const file = fileOf(d)
  if (s.format === 'toml') return readToml(await readText(file), s)
  const obj = (await readJsonFile(file))[s.key]
  const out: Record<string, McpServer> = {}
  if (obj && typeof obj === 'object')
    for (const [name, v] of Object.entries(obj))
      if (v && typeof v === 'object') out[name] = fromObject(name, v as any, s)
  return out
}

async function putServer(d: Def, sv: McpServer) {
  const s = d.mcpStore
  const file = fileOf(d)
  if (s.format === 'toml') {
    await mkdir(path.dirname(file), { recursive: true })
    return writeFile(file, writeToml(await readText(file), s, sv, sv.name), 'utf8')
  }
  const root = await readJsonFile(file)
  const table = (root[s.key] && typeof root[s.key] === 'object' ? root[s.key] : {}) as Record<string, any>
  table[sv.name] = toObject(sv, s, table[sv.name])
  root[s.key] = table
  await writeJsonAtomic(file, root)
}

async function dropServer(d: Def, name: string) {
  const s = d.mcpStore
  const file = fileOf(d)
  if (!existsSync(file)) return
  if (s.format === 'toml') return writeFile(file, writeToml(await readText(file), s, null, name), 'utf8')
  const root = await readJsonFile(file)
  if (!root[s.key] || !(name in root[s.key])) return
  delete root[s.key][name]
  await writeJsonAtomic(file, root)
}

export async function mcpOverview(): Promise<McpOverview> {
  const defs = managed()
  const per = await Promise.all(defs.map((d) => readServers(d).catch(() => ({}) as Record<string, McpServer>)))
  const by = new Map<string, McpEntry>()
  defs.forEach((d, i) => {
    for (const sv of Object.values(per[i])) {
      const cur = by.get(sv.name)
      if (cur) cur.clis.push(d.id)
      else by.set(sv.name, { ...sv, clis: [d.id] })
    }
  })
  return {
    clis: defs.map((d) => ({ id: d.id, name: d.name, file: d.mcpStore.file })),
    servers: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** 连上去问一下有哪些工具：能确认配置是对的 */
export async function testMcp(sv: McpServer): Promise<McpTestResult> {
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent-panel', version: '1' } },
  }
  const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
  const tools = (r: any) =>
    (r?.tools ?? []).map((x: any) => ({ name: String(x.name), description: String(x.description ?? '') }))
  try {
    if (sv.transport === 'http') {
      let session = ''
      const post = async (body: object) => {
        const res = await fetch(sv.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(session && { 'mcp-session-id': session }),
            ...sv.headers,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        session = res.headers.get('mcp-session-id') ?? session
        const text = await res.text()
        if (!('id' in body)) return null
        // 服务可能用 SSE 回答：取 data: 行里 id 对得上的那条
        const msgs = res.headers.get('content-type')?.includes('event-stream')
          ? text
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => JSON.parse(l.slice(5)))
          : [JSON.parse(text)]
        const m = msgs.find((x) => x.id === (body as any).id)
        if (m?.error) throw new Error(String(m.error.message ?? 'error'))
        return m?.result
      }
      const i = await post(init)
      await post(initialized)
      return { ok: true, server: i?.serverInfo?.name, tools: tools(await post(listTools)) }
    }
    const ac = new AbortController()
    const got: Record<number, any> = {}
    let error = ''
    const line = (o: object) => JSON.stringify(o) + '\n'
    const r = await runProcess({
      command: sv.command,
      args: sv.args,
      cwd: process.cwd(),
      env: childEnv(Object.entries(sv.env).map(([key, value]) => ({ key, value }))),
      signal: ac.signal,
      timeoutMs: 20_000,
      keepStdinOpen: true,
      stdin: line(init) + line(initialized) + line(listTools),
      onLine: (l) => {
        let m: any
        try {
          m = JSON.parse(l)
        } catch {
          return
        }
        if (typeof m.id !== 'number' || m.method) return
        if (m.error) error = String(m.error.message ?? '')
        got[m.id] = m.result ?? null
        if (m.id === 2 || m.error) ac.abort()
      },
    })
    if (!got[2]) throw new Error(error || r.spawnError || r.stderr.trim().split('\n').at(-1) || t('没有回应'))
    return { ok: true, server: got[1]?.serverInfo?.name, tools: tools(got[2]) }
  } catch (e) {
    return { ok: false, error: (e as Error).message, tools: [] }
  }
}

export function mcpApi() {
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
  return (
    new Hono()
      .get(
        '/',
        guard(async (c) => c.json(await mcpOverview())),
      )
      .post(
        '/test',
        guard(async (c) => c.json(await testMcp(parse(await c.req.json())))),
      )
      // 装到指定的 CLI 里，没选的 CLI 里同名的移除
      .put(
        '/:name',
        guard(async (c) => {
          const body = await c.req.json()
          const sv = parse({ ...body.server, name: c.req.param('name') })
          const want = new Set<string>(body.clis ?? [])
          for (const d of managed()) await (want.has(d.id) ? putServer(d, sv) : dropServer(d, sv.name))
          return c.json(await mcpOverview())
        }),
      )
      .delete(
        '/:name',
        guard(async (c) => {
          for (const d of managed()) await dropServer(d, c.req.param('name'))
          return c.json(await mcpOverview())
        }),
      )
  )
}
