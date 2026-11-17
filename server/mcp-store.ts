import { existsSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS, type CliDefinition } from '../shared/clis.ts'
import type { McpStore } from '../shared/cli-spec.ts'
import { McpServer, type McpEntry, type McpOverview, type McpTestResult } from '../shared/library.ts'
import { t } from '../shared/i18n.ts'
import { titleOfTool } from '../shared/mcp-catalog/tool-titles.ts'
import { mcpServerObject, sameServer, type McpActivation } from '../shared/mcp-library/inject.ts'
import { loadProjectMcp, saveProjectMcp } from './mcp-library/file.ts'
import { expandHome } from './cli/extras.ts'
import { childEnv, runProcess } from './exec/process.ts'
import { writeCliConfigJson, writeCliConfigText } from './cli/config-write.ts'
import { getSettings } from './settings.ts'
import { cliSettings } from '../shared/settings.ts'

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
  for (let m; (m = re.exec(h)) && m[0];) out.push(unquoteKey(m[1]))
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

/**
 * 从 { 名字: 配置 } 的表里读出工具。项目里各种 mcpServers / servers 写法共用这一处：
 * Claude Code、Cursor 的 mcpServers 和 VS Code 的 servers 字段名不同，但条目结构一样（见 server/projects/mcp.ts）
 */
export function readServerTable(table: Record<string, any>, s: McpStore): Record<string, McpServer> {
  const out: Record<string, McpServer> = {}
  for (const [name, v] of Object.entries(table))
    if (v && typeof v === 'object') out[name] = fromObject(name, v as any, s)
  return out
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

/** 比较两个目录是不是同一个：Claude Code 在 Windows 上存的键是正斜杠，盘符大小写也可能不同 */
const samePath = (a: string, b: string) => {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * 各 CLI 在自己的全局配置里按项目目录另存的 MCP（定义里的 mcpStore.projectTable，例如 Claude Code 的 local scope）。
 * 只读；读不到、读不懂的 CLI 跳过（这是顺带识别，不该让项目 MCP 页报错）
 */
export async function agentProjectServers(dir: string) {
  const out: { cli: string; file: string; servers: Record<string, McpServer>; raw: Record<string, unknown> }[] = []
  for (const d of managed()) {
    const s = d.mcpStore
    if (!s.projectTable || s.format !== 'json') continue
    const file = fileOf(d)
    if (!existsSync(file)) continue
    try {
      const table = (await readJsonFile(file))[s.projectTable]
      if (!table || typeof table !== 'object') continue
      const hit = Object.entries(table as Record<string, any>).find(([k]) => samePath(k, dir))?.[1]
      const raw = hit?.[s.key]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const servers: Record<string, McpServer> = {}
      for (const [name, v] of Object.entries(raw))
        if (v && typeof v === 'object') servers[name] = fromObject(name, v as any, s)
      if (Object.keys(servers).length) out.push({ cli: d.name, file: d.mcpStore.file, servers, raw })
    } catch {
      continue
    }
  }
  return out
}

async function putServer(d: Def, sv: McpServer) {
  const s = d.mcpStore
  const file = fileOf(d)
  if (s.format === 'toml') {
    await mkdir(path.dirname(file), { recursive: true })
    return writeCliConfigText(file, writeToml(await readText(file), s, sv, sv.name))
  }
  const root = await readJsonFile(file)
  const table = (root[s.key] && typeof root[s.key] === 'object' ? root[s.key] : {}) as Record<string, any>
  table[sv.name] = mcpServerObject(sv, s, table[sv.name])
  root[s.key] = table
  await writeCliConfigJson(file, root)
}

async function dropServer(d: Def, name: string) {
  const s = d.mcpStore
  const file = fileOf(d)
  if (!existsSync(file)) return
  if (s.format === 'toml') return writeCliConfigText(file, writeToml(await readText(file), s, null, name))
  const root = await readJsonFile(file)
  if (!root[s.key] || !(name in root[s.key])) return
  delete root[s.key][name]
  await writeCliConfigJson(file, root)
}

export async function mcpOverview(): Promise<McpOverview> {
  // 停用的 CLI 不在列表和安装目标里出现
  const settings = await getSettings()
  const defs = managed().filter((d) => cliSettings(settings, d.id).enabled)
  const per = await Promise.all(defs.map((d) => readServers(d).catch(() => ({}) as Record<string, McpServer>)))
  const lib = await loadProjectMcp()
  const by = new Map<string, McpEntry>()
  const ownIn = new Map<string, string[]>()
  defs.forEach((d, i) => {
    for (const sv of Object.values(per[i])) {
      // 按项目的条目以面板库里的为准：退回全局写入的那几份不另列；能注入的 CLI 里还有同名的，
      // 说明面板没清（和条目不一样，多半是用户自己在 CLI 里加的），标出来
      const p = lib[sv.name]
      if (p) {
        if (d.mcpStore.inject) ownIn.set(sv.name, [...(ownIn.get(sv.name) ?? []), d.id])
        continue
      }
      const cur = by.get(sv.name)
      if (cur) cur.clis.push(d.id)
      else by.set(sv.name, { ...sv, clis: [d.id], activation: 'global' })
    }
  })
  for (const [name, e] of Object.entries(lib)) {
    const clis = e.clis.filter((id) => defs.some((d) => d.id === id))
    const fallback = clis.filter((id) => !defs.find((d) => d.id === id)?.mcpStore.inject)
    by.set(name, {
      ...e.server,
      clis,
      activation: 'project',
      ...(fallback.length && { fallback }),
      ...(ownIn.has(name) && { ownIn: ownIn.get(name) }),
    })
  }
  return {
    clis: defs.map((d) => ({ id: d.id, name: d.name, file: d.mcpStore.file, perProject: !!d.mcpStore.inject })),
    servers: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * 保存一个条目（「MCP 工具」页和项目设置里的 MCP 共用这一个入口）：
 * - 全局：装进选中的 CLI 的全局配置，没选的 CLI 里同名的移除（以前的行为）；从按项目改回来时删掉面板库里那份。
 * - 按项目：存进面板库，每轮按项目注入。能注入的 CLI 的全局配置里面板以前写过的（内容和这个条目、
 *   改之前的条目一样）清掉；不一样的是用户自己在 CLI 里配的，不动。不能注入的 CLI 退回全局写入。
 * activation 不给时保持原来的；previous 是界面上改之前的条目，用来认出面板以前写进全局配置的那份
 */
export async function saveMcpEntry(sv: McpServer, want: string[], activation?: McpActivation, previous?: McpServer) {
  const lib = await loadProjectMcp()
  const old = lib[sv.name]
  const act = activation ?? (old ? 'project' : 'global')
  const set = new Set(want)
  if (act === 'global') {
    if (old) {
      delete lib[sv.name]
      await saveProjectMcp(lib)
    }
    for (const d of managed()) await (set.has(d.id) ? putServer(d, sv) : dropServer(d, sv.name))
    return
  }
  const mine = [sv, old?.server, previous].filter((x): x is McpServer => !!x)
  for (const d of managed()) {
    if (!d.mcpStore.inject) {
      await (set.has(d.id) ? putServer(d, sv) : dropServer(d, sv.name))
      continue
    }
    const cur = (await readServers(d))[sv.name]
    if (cur && mine.some((m) => sameServer(cur, m))) await dropServer(d, sv.name)
  }
  lib[sv.name] = { server: sv, clis: want }
  await saveProjectMcp(lib)
}

/** 删掉一个条目：全局的从所有 CLI 里移除；按项目的删掉面板库里那份和退回全局写入的几份，用户自己另配的不动 */
export async function deleteMcpEntry(name: string) {
  const lib = await loadProjectMcp()
  const old = lib[name]
  if (!old) {
    for (const d of managed()) await dropServer(d, name)
    return
  }
  for (const d of managed()) {
    const cur = d.mcpStore.inject ? (await readServers(d))[name] : undefined
    if (!d.mcpStore.inject || (cur && sameServer(cur, old.server))) await dropServer(d, name)
  }
  delete lib[name]
  await saveProjectMcp(lib)
}

/**
 * 插件声明的 MCP 服务（插件接口 11）退回全局写入：只对没有每轮注入（mcpStore.inject）的 CLI。
 * prev 是上次面板替插件写进去的，want 是现在该有的：prev 里不再要的删掉（内容和当时写的一样才删，用户改过的不动），
 * want 里的写进去（已有同名、但不是面板上次写的那份时不覆盖，那是用户自己配的）。返回实际写进去的
 */
export async function syncFallbackServers(want: McpServer[], prev: McpServer[]): Promise<McpServer[]> {
  const written: McpServer[] = []
  for (const d of managed().filter((x) => !x.mcpStore.inject)) {
    const cur = await readServers(d).catch(() => ({}) as Record<string, McpServer>)
    for (const old of prev)
      if (!want.some((w) => w.name === old.name) && cur[old.name] && sameServer(cur[old.name], old))
        await dropServer(d, old.name)
    for (const sv of want) {
      const have = cur[sv.name]
      const ours = prev.find((x) => x.name === sv.name)
      if (have && !(ours && sameServer(have, ours)) && !sameServer(have, sv)) continue
      if (!have || !sameServer(have, sv)) await putServer(d, sv)
      if (!written.some((w) => w.name === sv.name)) written.push(sv)
    }
  }
  return written
}

/** 没有每轮注入、只能全局写入的 CLI（界面上注明「退回全局写入」用） */
export const fallbackClis = () =>
  managed()
    .filter((d) => !d.mcpStore.inject)
    .map((d) => d.id)

/**
 * 连上去问一下有哪些工具：能确认配置是对的。
 * cwd 给了就在那个目录里启动（项目里的配置常写相对路径，例如 UEToVS 的 --solution-dir .），不给用面板自己的目录
 */
export async function testMcp(sv: McpServer, cwd = process.cwd()): Promise<McpTestResult> {
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent-panel', version: '1' } },
  }
  const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
  const tools = (r: any) =>
    (r?.tools ?? []).map((x: any) => {
      const shown = titleOfTool(x)
      return { name: String(x.name), description: String(x.description ?? ''), ...(shown && { shown }) }
    })
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
      cwd,
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

/** 请求里的生效方式：只认两个值，别的当没给（保持原来的） */
export const activationOf = (v: unknown): McpActivation | undefined =>
  v === 'global' || v === 'project' ? v : undefined
/** 请求里改之前的条目：读不懂就当没给，只用来认出面板写过的全局配置 */
export const previousOf = (v: unknown): McpServer | undefined => {
  const p = McpServer.safeParse(v)
  return p.success ? p.data : undefined
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
          await saveMcpEntry(sv, body.clis ?? [], activationOf(body.activation), previousOf(body.previous))
          return c.json(await mcpOverview())
        }),
      )
      .delete(
        '/:name',
        guard(async (c) => {
          await deleteMcpEntry(c.req.param('name'))
          return c.json(await mcpOverview())
        }),
      )
  )
}
