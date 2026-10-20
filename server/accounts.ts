import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { CLIS, getCli, type CliDefinition } from '../shared/clis.ts'
import { apiFits, apiInjection, apiProvider, fillEdits, ApiConfig, type JsonEdit } from '../shared/accounts.ts'
import { CliSettings, type CliAccounts, type LoginJob, type SavedAccount, type Settings } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { t } from '../shared/i18n.ts'
import { capture, childEnv, runProcess } from './exec/process.ts'
import { invalidateClis } from './detect.ts'
import { invalidateModels } from './models.ts'
import { log } from './log.ts'
import { getSettings, saveSettings } from './settings.ts'
import { detectApis } from './api-detect.ts'
import { parseToml } from './mcp-store.ts'
import { dataPath, writeJsonAtomic, readJson } from './store.ts'

/**
 * CLI 的账号：登录最终就是在 CLI 的配置目录里写下凭据文件，所以
 * - 保存账号 = 把凭据文件（和钥匙串里的条目）存一份到数据目录的 accounts/ 下
 * - 切换账号 = 把存好的凭据写回 CLI 的配置目录，CLI 的其他配置、Skill、会话都不动
 * - 登出 = 把现在的凭据先存好，再从 CLI 的配置目录里删掉，之后随时能切回来
 * CLI 会自己刷新登录凭据（刷新后旧的可能失效），所以每次操作前先把现在的凭据同步回对应的已存账号。
 * 凭据只在本机的数据目录里，不进数据导出。
 */

const ROOT = dataPath('accounts')

interface Snapshot {
  /** 凭据文件：相对 home 的路径 → base64 内容 */
  files: Record<string, string>
  /** 其他 JSON 文件里属于账号的键：文件（配置里的写法）→ 键 → 值 */
  fields: Record<string, Record<string, unknown>>
  keychain?: string
}

interface Index {
  active: string
  accounts: SavedAccount[]
}

/** 展开路径：~ 是用户目录，${ENV:-默认值} 先取这个 CLI 运行时的环境变量 */
const expand = (dir: string, env: NodeJS.ProcessEnv) => {
  const d = dir.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k: string, def = '') => env[k] || def)
  return d === '~' || d.startsWith('~/') ? path.join(homedir(), d.slice(1)) : path.resolve(d)
}

const indexFile = (cli: string) => path.join(ROOT, `${cli}.json`)
const slotFile = (cli: string, id: string) => path.join(ROOT, cli, `${id}.json`)

async function readIndex(cli: string): Promise<Index> {
  const raw = (await readJson(indexFile(cli))) as Partial<Index> | undefined
  return { active: raw?.active ?? '', accounts: Array.isArray(raw?.accounts) ? raw.accounts : [] }
}
const writeIndex = async (cli: string, i: Index) => {
  await mkdir(ROOT, { recursive: true })
  await writeJsonAtomic(indexFile(cli), i)
}
async function writeSlot(cli: string, id: string, snap: Snapshot) {
  await mkdir(path.join(ROOT, cli), { recursive: true })
  const file = slotFile(cli, id)
  await writeFile(file, JSON.stringify(snap), { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
}
const readSlot = async (cli: string, id: string) => (await readJson(slotFile(cli, id))) as Snapshot | undefined

// ---- 读写 CLI 现在的登录 ----

const readJsonFile = async (file: string) => {
  try {
    const v = JSON.parse(await readFile(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined
  } catch {
    return undefined
  }
}

async function keychainRead(service: string) {
  if (process.platform !== 'darwin' || !service) return undefined
  const r = await capture('security', ['find-generic-password', '-s', service, '-w'], homedir(), process.env, 10_000)
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
}
const keychainUser = () => {
  try {
    return userInfo().username
  } catch {
    return 'user'
  }
}

async function readLive(def: CliDefinition, env: NodeJS.ProcessEnv): Promise<Snapshot | undefined> {
  const a = def.auth!
  const home = expand(a.home, env)
  const snap: Snapshot = { files: {}, fields: {} }
  for (const rel of a.files) {
    const b = await readFile(path.join(home, rel)).catch(() => undefined)
    if (b) snap.files[rel] = b.toString('base64')
  }
  for (const f of a.fields) {
    const obj = await readJsonFile(expand(f.file, env))
    const picked = Object.fromEntries(f.keys.filter((k) => obj && k in obj).map((k) => [k, obj![k]]))
    if (Object.keys(picked).length) snap.fields[f.file] = picked
  }
  snap.keychain = await keychainRead(a.keychain)
  // 没有凭据文件也没有钥匙串条目：没登录
  return Object.keys(snap.files).length || snap.keychain ? snap : undefined
}

async function writeLive(def: CliDefinition, env: NodeJS.ProcessEnv, snap: Snapshot) {
  const a = def.auth!
  const home = expand(a.home, env)
  for (const rel of a.files) {
    const file = path.join(home, rel)
    if (rel in snap.files) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, Buffer.from(snap.files[rel], 'base64'), { mode: 0o600 })
      await chmod(file, 0o600).catch(() => {})
    } else await rm(file, { force: true })
  }
  for (const f of a.fields) {
    const file = expand(f.file, env)
    const obj = (await readJsonFile(file)) ?? {}
    // 文件存在但解析不了（别的程序正在写）时不动它，免得把别的内容冲掉
    if (existsSync(file) && !(await readJsonFile(file))) continue
    for (const k of f.keys) {
      if (snap.fields[f.file]?.[k] !== undefined) obj[k] = snap.fields[f.file][k]
      else delete obj[k]
    }
    await mkdir(path.dirname(file), { recursive: true })
    await writeJsonAtomic(file, obj)
  }
  if (a.keychain && process.platform === 'darwin') {
    if (snap.keychain)
      await capture(
        'security',
        ['add-generic-password', '-U', '-s', a.keychain, '-a', keychainUser(), '-w', snap.keychain],
        homedir(),
        process.env,
        10_000,
      )
    else await capture('security', ['delete-generic-password', '-s', a.keychain], homedir(), process.env, 10_000)
  }
}

async function clearLive(def: CliDefinition, env: NodeJS.ProcessEnv) {
  await writeLive(def, env, { files: {}, fields: {} })
}

// ---- 认出是哪个账号 ----

const jwtPayload = (jwt: unknown) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, any>
  } catch {
    return {}
  }
}

/** 从凭据里读出邮箱和一句说明；读不出来的返回空 */
export function identityOf(def: CliDefinition, snap: Snapshot): { email: string; label: string } {
  const file = (rel: string) => {
    try {
      return JSON.parse(Buffer.from(snap.files[rel] ?? '', 'base64').toString('utf8')) as Record<string, any>
    } catch {
      return {}
    }
  }
  switch (def.auth?.identity) {
    case 'codex': {
      const a = file('auth.json')
      const email = String(jwtPayload(a.tokens?.id_token).email ?? '')
      return { email, label: email || (a.OPENAI_API_KEY ? 'API Key' : '') }
    }
    case 'claude': {
      const acc = Object.values(snap.fields).find((f) => f.oauthAccount)?.oauthAccount as
        | Record<string, any>
        | undefined
      const email = String(acc?.emailAddress ?? '')
      return { email, label: [email, acc?.organizationName].filter(Boolean).join(' · ') }
    }
    case 'gemini': {
      const email = String(file('google_accounts.json').active ?? '')
      return { email, label: email }
    }
    default:
      return { email: '', label: '' }
  }
}

const fingerprint = (snap: Snapshot) =>
  createHash('sha256')
    .update(JSON.stringify([snap.files, snap.keychain ?? '']))
    .digest('hex')
    .slice(0, 16)

/** 现在的登录对应哪个已存的账号：认得出邮箱的按邮箱，认不出的按凭据内容 */
function matchSlot(def: CliDefinition, idx: Index, live: Snapshot, slots: Map<string, Snapshot>) {
  const me = identityOf(def, live)
  return idx.accounts.find((a) => {
    if (me.email) return a.email === me.email
    const s = slots.get(a.id)
    return !!s && fingerprint(s) === fingerprint(live)
  })
}

async function loadSlots(cli: string, idx: Index) {
  const m = new Map<string, Snapshot>()
  for (const a of idx.accounts) {
    const s = await readSlot(cli, a.id)
    if (s) m.set(a.id, s)
  }
  return m
}

/** 这个 CLI 改用账号（只改 authMode，别的设置原样） */
async function setAccountMode(cli: string) {
  const s = await getSettings()
  if (s.clis[cli]?.authMode === 'account') return
  await saveSettings({
    ...s,
    clis: { ...s.clis, [cli]: CliSettings.parse({ ...(s.clis[cli] ?? {}), authMode: 'account' }) },
  })
}

async function envOf(cli: string) {
  const settings = await getSettings()
  // 登录相关的操作按账号模式的环境来（API 模式加的环境变量不带进来）
  const cs = cliSettings(
    { ...settings, clis: { ...settings.clis, [cli]: { ...settings.clis[cli], authMode: 'account' } } as any },
    cli,
  )
  return { cs, env: childEnv(cs.env) }
}

/** 把现在的登录同步回对应的已存账号（CLI 刷新过凭据后，保存的也要跟着更新） */
async function sync(def: CliDefinition, env: NodeJS.ProcessEnv) {
  const idx = await readIndex(def.id)
  const live = await readLive(def, env)
  if (!live) return { idx, live, matched: undefined as SavedAccount | undefined }
  const slots = await loadSlots(def.id, idx)
  const matched = matchSlot(def, idx, live, slots)
  if (matched && JSON.stringify(slots.get(matched.id)) !== JSON.stringify(live))
    await writeSlot(def.id, matched.id, live)
  if (idx.active !== (matched?.id ?? '')) {
    idx.active = matched?.id ?? ''
    await writeIndex(def.id, idx)
  }
  return { idx, live, matched }
}

async function saveAs(def: CliDefinition, snap: Snapshot, name?: string): Promise<SavedAccount> {
  const idx = await readIndex(def.id)
  const slots = await loadSlots(def.id, idx)
  const me = identityOf(def, snap)
  // 认得出邮箱的按邮箱找已有的，认不出的按凭据内容找：同一个账号不重复保存
  const same = me.email
    ? idx.accounts.find((a) => a.email === me.email)
    : idx.accounts.find((a) => {
        const old = slots.get(a.id)
        return !!old && fingerprint(old) === fingerprint(snap)
      })
  const acc: SavedAccount = same ?? {
    id: randomUUID().slice(0, 8),
    name: name?.trim() || me.email || t('{cli} 账号 {n}', { cli: def.name, n: idx.accounts.length + 1 }),
    email: me.email,
    savedAt: new Date().toISOString(),
  }
  if (same) acc.savedAt = new Date().toISOString()
  await writeSlot(def.id, acc.id, snap)
  idx.accounts = same ? idx.accounts.map((a) => (a.id === acc.id ? acc : a)) : [...idx.accounts, acc]
  idx.active = acc.id
  await writeIndex(def.id, idx)
  return acc
}

export async function listAccounts(def: CliDefinition): Promise<CliAccounts> {
  const { env } = await envOf(def.id)
  const { idx, live, matched } = await sync(def, env)
  const me = live ? identityOf(def, live) : { email: '', label: '' }
  return {
    cli: def.id,
    canLogin: !!def.auth?.login.length,
    canApi: !!def.auth?.api,
    live: { loggedIn: !!live, email: me.email, label: me.label },
    unsaved: !!live && !matched,
    accounts: idx.accounts.map((a) => ({ ...a, active: a.id === matched?.id })),
  }
}

// ---- 改 JSON 配置（API 模式、登录前） ----

const setPath = (obj: Record<string, any>, dotted: string, value: unknown) => {
  const keys = dotted.split('.')
  let cur = obj
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[keys.at(-1)!] = value
}
const getPath = (obj: any, dotted: string) => {
  let cur = obj
  for (const k of dotted.split('.')) cur = cur?.[k]
  return cur
}
const unsetPath = (obj: Record<string, any>, dotted: string) => {
  const keys = dotted.split('.')
  let cur: any = obj
  for (const k of keys.slice(0, -1)) cur = cur?.[k]
  if (cur && typeof cur === 'object') delete cur[keys.at(-1)!]
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 深度合并 JSON 对象；数组和标量直接替换，已有对象里的键保留 */
export function mergeJson(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = mergeJson(base[k], v)
  return out
}

/** 只改要改的键，文件里别的内容原样保留；文件存在但解析不了时不动它 */
async function applyJsonEdit(e: JsonEdit, env: NodeJS.ProcessEnv) {
  const file = expand(e.file, env)
  const exists = existsSync(file)
  const obj = await readJsonFile(file)
  if (exists && !obj) {
    log.warn('accounts', '配置文件解析不了，没有改', { file })
    return
  }
  const next = obj ?? {}
  const before = JSON.stringify(next)
  for (const [k, v] of Object.entries(e.set)) setPath(next, k, e.merge ? mergeJson(getPath(next, k), v) : v)
  for (const k of e.unset) unsetPath(next, k)
  if (JSON.stringify(next) === before && exists) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeJsonAtomic(file, next)
}

// ---- TOML：只改命中的顶层键和表，文件里别的段和注释原样保留 ----

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))

function tomlLiteral(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(tomlLiteral).join(', ')}]`
  if (isObj(v))
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${tomlKey(k)} = ${tomlLiteral(x)}`)
      .join(', ')} }`
  return '""'
}

function tomlHeader(line: string): string[] | undefined {
  const m = /^\s*\[(?!\[)((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')+)\]\s*(?:#.*)?$/.exec(line)
  if (!m) return undefined
  return m[1].split('.').map((s) => s.trim().replace(/^["']|["']$/g, ''))
}

function tomlRange(lines: string[], parts: string[]) {
  const target = parts.join('.')
  const from = lines.findIndex((l) => tomlHeader(l)?.join('.') === target)
  if (from < 0) return undefined
  let to = lines.length
  for (let i = from + 1; i < lines.length; i++)
    if (tomlHeader(lines[i])) {
      to = i
      break
    }
  return { from, to }
}

function tomlRootIndex(lines: string[], key: string) {
  const firstSection = lines.findIndex((l) => tomlHeader(l))
  const end = firstSection < 0 ? lines.length : firstSection
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  for (let i = 0; i < end; i++) if (re.test(lines[i])) return i
  return -1
}

function setToml(text: string, dotted: string, value: unknown, merge: boolean) {
  const lines = text ? text.split(/\r?\n/) : []
  while (lines.length && lines.at(-1) === '') lines.pop()
  const parts = dotted.split('.')
  if (parts.length === 1) {
    const line = `${tomlKey(parts[0])} = ${tomlLiteral(value)}`
    const at = tomlRootIndex(lines, parts[0])
    if (at >= 0) lines[at] = line
    else {
      const firstSection = lines.findIndex((l) => tomlHeader(l))
      lines.splice(firstSection < 0 ? lines.length : firstSection, 0, line)
    }
  } else {
    const range = tomlRange(lines, parts)
    let obj: Record<string, unknown> = {}
    if (range && merge) {
      const parsed = parseToml(lines.slice(range.from, range.to).join('\n'))
      let cur: any = parsed
      for (const p of parts) cur = cur?.[p]
      if (isObj(cur)) obj = { ...cur }
    }
    if (isObj(value)) obj = { ...obj, ...value }
    const block = [
      `[${parts.map(tomlKey).join('.')}]`,
      ...Object.entries(obj).map(([k, v]) => `${tomlKey(k)} = ${tomlLiteral(v)}`),
    ]
    if (range) lines.splice(range.from, range.to - range.from, ...block)
    else {
      if (lines.length) lines.push('')
      lines.push(...block)
    }
  }
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}

function unsetToml(text: string, dotted: string) {
  const lines = text ? text.split(/\r?\n/) : []
  while (lines.length && lines.at(-1) === '') lines.pop()
  const parts = dotted.split('.')
  if (parts.length === 1) {
    const at = tomlRootIndex(lines, parts[0])
    if (at >= 0) lines.splice(at, 1)
  } else {
    const range = tomlRange(lines, parts)
    if (range) lines.splice(range.from, range.to - range.from)
  }
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}

async function applyTomlEdit(e: JsonEdit, env: NodeJS.ProcessEnv) {
  const file = expand(e.file, env)
  const exists = existsSync(file)
  const before = exists ? await readFile(file, 'utf8') : ''
  let next = before
  for (const [k, v] of Object.entries(e.set)) next = setToml(next, k, v, e.merge)
  for (const k of e.unset) next = unsetToml(next, k)
  if (next === before && exists) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, next, 'utf8')
}

// ---- .env：只改命中的键，注释和别的变量原样保留 ----

const envLine = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)

function envValue(v: unknown) {
  const s = String(v)
  return s && /^[A-Za-z0-9_./:@%+-]*$/.test(s) ? s : JSON.stringify(s)
}

async function applyEnvEdit(e: JsonEdit, env: NodeJS.ProcessEnv) {
  const file = expand(e.file, env)
  const exists = existsSync(file)
  const before = exists ? await readFile(file, 'utf8') : ''
  const lines = before ? before.split(/\r?\n/) : []
  while (lines.length && lines.at(-1) === '') lines.pop()
  for (const key of e.unset)
    for (let i = lines.length - 1; i >= 0; i--) if (envLine(key).test(lines[i])) lines.splice(i, 1)
  for (const [key, value] of Object.entries(e.set)) {
    const line = `${key}=${envValue(value)}`
    const at = lines.findIndex((l) => envLine(key).test(l))
    if (at >= 0) lines[at] = line
    else lines.push(line)
  }
  const next = lines.length ? lines.join('\n').trimEnd() + '\n' : ''
  if (next === before && exists) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, next, 'utf8')
}

async function applyEdits(edits: JsonEdit[], env: NodeJS.ProcessEnv) {
  for (const e of edits) {
    if (e.format === 'toml') await applyTomlEdit(e, env)
    else if (e.format === 'env') await applyEnvEdit(e, env)
    else await applyJsonEdit(e, env)
  }
}

/**
 * 调用 CLI 之前：按这个 CLI 现在用账号还是 API，把配置文件改成对应的样子
 * （例如 Gemini CLI 的登录方式、Command Code 的自定义接口）。没有这类配置的 CLI 什么都不做
 */
export async function prepareAuth(cliId: string, lastProvider?: string) {
  const def = getCli(cliId)
  const spec = def?.auth?.api
  if (!def?.auth || !spec || (!spec.edits.length && !spec.accountEdits.length)) return
  try {
    const settings = await getSettings()
    const cs = cliSettings(settings, cliId)
    const env = childEnv(cs.env)
    if (cs.api && apiFits(def.auth, cs.api)) await applyEdits(apiInjection(def.auth, cs.api).edits, env)
    else {
      // 切回账号时优先用上一次真正写进去的 provider；没有时再用当前选中的 API
      const selected = settings.apis.find((a) => a.id === cs.apiId)
      const cleanup = lastProvider ? undefined : selected && apiFits(def.auth, selected) ? selected : undefined
      await applyEdits(fillEdits(spec.accountEdits, def.auth, cleanup, lastProvider), env)
    }
  } catch (e) {
    log.warn('accounts', '切换账号 / API 的配置没写成功', { cli: cliId, error: (e as Error).message })
  }
}

/**
 * 和配置写入有关的设置指纹：只有这些变了才重写 CLI 配置文件。
 * 只算选了哪个 API，不算 API 自己的地址、密钥、模型：改 API 不自动改 CLI 的配置文件，
 * 由设置里的「一键更新」写进去
 */
function authSignature(settings: Settings, cliId: string) {
  const cs = cliSettings(settings, cliId)
  return JSON.stringify([cs.enabled, cs.authMode, cs.apiId])
}

/**
 * 设置保存后：切换了登录方式、或换了 API 的 CLI，立即把配置写进 CLI 自己的配置文件（不用等到执行）。
 * 改 API 自己的地址、密钥、模型不在这里写，由设置里的「一键更新」写
 */
export async function syncCliAuths(prev: Settings, next: Settings) {
  for (const def of CLIS) {
    if (!def.auth?.api) continue
    if (authSignature(prev, def.id) === authSignature(next, def.id)) continue
    const prevCs = cliSettings(prev, def.id)
    const prevApi = prev.apis.find((a) => a.id === prevCs.apiId)
    const lastProvider = prevApi ? apiProvider(prevApi, def.auth.api.defaultProvider) : undefined
    await prepareAuth(def.id, lastProvider)
    invalidateModels(def.id)
  }
}

/**
 * 把某个 API 当前的设置（地址、密钥、模型）写进所有正在用它的 CLI 配置文件。
 * 设置页里改 API 不自动写，用户点「一键更新」才调这里；返回更新了哪些 CLI
 */
export async function applyApiToClis(apiId: string) {
  const settings = await getSettings()
  const clis: string[] = []
  for (const def of CLIS) {
    if (!def.auth?.api) continue
    const cs = cliSettings(settings, def.id)
    if (cs.authMode !== 'api' || cs.apiId !== apiId) continue
    await prepareAuth(def.id)
    invalidateModels(def.id)
    clis.push(def.id)
  }
  return clis
}

// ---- 登录 ----

interface Login extends LoginJob {
  abort: AbortController
  write?: (s: string) => void
}
const logins = new Map<string, Login>()
const view = ({ abort, write, ...rest }: Login): LoginJob => rest

const URL_RE = /https?:\/\/[^\s"'<>]+/g
/** 输出里的登录网址：本机回调地址（localhost）不算 */
const findUrl = (text: string) =>
  (text.match(URL_RE) ?? []).find((u) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(u)) ?? ''

const LOGIN_TIMEOUT = 5 * 60_000

async function startLogin(def: CliDefinition): Promise<LoginJob> {
  const running = logins.get(def.id)
  if (running?.status === 'running') return view(running)
  const a = def.auth
  if (!a?.login.length) throw new Error(t('{cli} 不能在面板里登录', { cli: def.name }))
  const { cs, env } = await envOf(def.id)
  // 现在登录着但还没存下来的账号先存好，登录新账号不会把它弄丢
  const { live, matched } = await sync(def, env)
  if (live && !matched) await saveAs(def, live)
  await applyEdits(a.loginEdits, env)
  const before = live ? fingerprint(live) : ''
  const job: Login = {
    id: randomUUID(),
    cli: def.id,
    status: 'running',
    url: '',
    output: '',
    startedAt: Date.now(),
    abort: new AbortController(),
  }
  logins.set(def.id, job)
  const take = (text: string) => {
    job.output = (job.output + text + '\n').slice(-4000)
    job.url ||= findUrl(job.output)
  }
  let settled = false
  const finish = async (ok: boolean, error?: string) => {
    if (settled) return
    settled = true
    clearInterval(poll)
    if (ok) {
      const now = await readLive(def, env)
      if (now) {
        await saveAs(def, now)
        // 登录了账号就用账号
        await setAccountMode(def.id)
        invalidateModels(def.id)
        invalidateClis()
        job.status = 'done'
      } else {
        job.status = 'failed'
        job.error = t('登录没有完成：没有找到登录凭据')
      }
    } else {
      job.status = 'failed'
      job.error = error
    }
    job.abort.abort()
  }
  // 凭据一变就算登录成功：有的 CLI（Gemini CLI）登录后接着往下跑，不会自己退出
  const poll = setInterval(async () => {
    const now = await readLive(def, env).catch(() => undefined)
    if (now && fingerprint(now) !== before) void finish(true)
    else if (Date.now() - job.startedAt > LOGIN_TIMEOUT) void finish(false, t('超过 5 分钟没有登录，已取消'))
  }, 600)
  void runProcess({
    command: cs.command,
    args: a.login,
    cwd: homedir(),
    env,
    signal: job.abort.signal,
    timeoutMs: LOGIN_TIMEOUT + 10_000,
    onSpawn: (io) => {
      job.write = io.write
      if (a.loginStdin) io.write(a.loginStdin)
    },
    onLine: take,
    onStderr: (s) => take(s.trimEnd()),
  }).then(async (r) => {
    if (settled) return
    if (r.spawnError) return finish(false, r.spawnError)
    const now = await readLive(def, env).catch(() => undefined)
    if (now && fingerprint(now) !== before) return finish(true)
    finish(
      false,
      r.killed === 'stopped'
        ? t('已取消')
        : [
            t('{cli} 没有完成登录（退出码 {code}）', { cli: def.name, code: String(r.code) }),
            job.output.trim().split('\n').slice(-3).join('\n'),
          ]
            .filter(Boolean)
            .join('\n'),
    )
  })
  return view(job)
}

// ---- 全局 API：读接口的模型列表 ----

/** 从 API 读可用的模型：按协议用对应的接口和请求头 */
export async function fetchApiModels(api: Pick<ApiConfig, 'protocol' | 'baseUrl' | 'apiKey' | 'authHeader'>) {
  const base = api.baseUrl.trim().replace(/\/+$/, '')
  if (!base && api.protocol !== 'gemini') throw new Error(t('先填接口地址'))
  const url =
    api.protocol === 'gemini'
      ? `${base || 'https://generativelanguage.googleapis.com'}/v1beta/models?pageSize=200`
      : api.protocol === 'anthropic'
        ? `${base}${/\/v1$/.test(base) ? '' : '/v1'}/models?limit=1000`
        : `${base}/models`
  const headers: Record<string, string> =
    api.protocol === 'gemini'
      ? { 'x-goog-api-key': api.apiKey }
      : api.protocol === 'anthropic'
        ? {
            'anthropic-version': '2023-06-01',
            ...(api.authHeader === 'bearer' ? { authorization: `Bearer ${api.apiKey}` } : { 'x-api-key': api.apiKey }),
          }
        : { authorization: `Bearer ${api.apiKey}` }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
    throw new Error(t('连不上接口：{error}', { error: e.message }))
  })
  const body = (await res.json().catch(() => undefined)) as any
  if (!res.ok)
    throw new Error(
      t('接口返回 {status}：{detail}', {
        status: String(res.status),
        detail: String(body?.error?.message ?? body?.error ?? body?.message ?? res.statusText).slice(0, 200),
      }),
    )
  const list: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  const ids = list
    .map((m: any) => (typeof m === 'string' ? m : String(m?.id ?? m?.name ?? '').replace(/^models\//, '')))
    .filter(Boolean)
  if (!ids.length) throw new Error(t('接口没有返回模型列表，请自己填写'))
  return [...new Set(ids)].sort()
}

export function accountsApi() {
  const need = (c: { req: { param: (k: string) => string } }) => {
    const def = getCli(c.req.param('cli'))
    if (!def?.auth) throw new Error(t('这个 CLI 没有账号设置'))
    return def
  }
  const guard = (fn: (c: any) => Promise<Response>) => async (c: any) => {
    try {
      return await fn(c)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  return (
    new Hono()
      .get(
        '/',
        guard(async (c) => c.json(await Promise.all(CLIS.filter((d) => d.auth).map((d) => listAccounts(d))))),
      )
      // 各个 CLI 自己配置里识别到的 API，页面确认后存进全局 API 列表
      .get(
        '/detected-apis',
        guard(async (c) => c.json(await detectApis())),
      )
      // 把某个 API 当前的设置写进正在用它的 CLI 配置文件（设置页的「一键更新」）
      .post(
        '/apis/:id/apply',
        guard(async (c) => {
          const id = c.req.param('id')
          const settings = await getSettings()
          if (!settings.apis.some((a) => a.id === id)) return c.json({ error: t('找不到这个 API') }, 404)
          return c.json({ clis: await applyApiToClis(id) })
        }),
      )
      // 读 API 的模型列表（在服务端请求，页面直接请求会被跨域挡住）
      .post(
        '/api-models',
        guard(async (c) => {
          const p = ApiConfig.pick({ protocol: true, baseUrl: true, apiKey: true, authHeader: true }).safeParse(
            await c.req.json(),
          )
          if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
          return c.json({ models: await fetchApiModels(p.data) })
        }),
      )
      .post(
        '/:cli/login',
        guard(async (c) => c.json(await startLogin(need(c)))),
      )
      .get('/:cli/login', (c) => {
        const j = logins.get(c.req.param('cli'))
        return c.json(j ? view(j) : null)
      })
      // 登录时 CLI 要求粘贴授权码（浏览器连不上本机回调时）
      .post(
        '/:cli/login/input',
        guard(async (c) => {
          const { text = '' } = (await c.req.json().catch(() => ({}))) as { text?: string }
          const j = logins.get(c.req.param('cli'))
          if (j?.status !== 'running' || !j.write) return c.json({ error: t('没有在登录') }, 400)
          j.write(`${String(text).trim()}\n`)
          return c.json({ ok: true })
        }),
      )
      .delete('/:cli/login', (c) => {
        logins.get(c.req.param('cli'))?.abort.abort()
        return c.json({ ok: true })
      })
      // 保存现在登录着的账号
      .post(
        '/:cli/save',
        guard(async (c) => {
          const def = need(c)
          const { name = '' } = (await c.req.json().catch(() => ({}))) as { name?: string }
          const { env } = await envOf(def.id)
          const live = await readLive(def, env)
          if (!live) return c.json({ error: t('现在没有登录') }, 400)
          await saveAs(def, live, name)
          return c.json(await listAccounts(def))
        }),
      )
      // 切换账号：先把现在的凭据同步存好，再写入要用的账号
      .post(
        '/:cli/switch',
        guard(async (c) => {
          const def = need(c)
          const { id = '' } = (await c.req.json().catch(() => ({}))) as { id?: string }
          const { env } = await envOf(def.id)
          const { live, matched } = await sync(def, env)
          const snap = await readSlot(def.id, id)
          const idx = await readIndex(def.id)
          if (!snap || !idx.accounts.some((a) => a.id === id)) return c.json({ error: t('没有这个账号') }, 400)
          if (live && !matched) await saveAs(def, live)
          await writeLive(def, env, snap)
          const next = await readIndex(def.id)
          next.active = id
          await writeIndex(def.id, next)
          // 切换账号就是要用账号
          await setAccountMode(def.id)
          invalidateModels(def.id)
          return c.json(await listAccounts(def))
        }),
      )
      // 登出：凭据先存好（之后能切回来），再从 CLI 的配置里去掉。不调用 CLI 自己的登出，那会让服务端作废令牌，存下的账号也就用不了了
      .post(
        '/:cli/logout',
        guard(async (c) => {
          const def = need(c)
          const { env } = await envOf(def.id)
          const { live, matched } = await sync(def, env)
          if (live && !matched) await saveAs(def, live)
          await clearLive(def, env)
          const idx = await readIndex(def.id)
          idx.active = ''
          await writeIndex(def.id, idx)
          invalidateModels(def.id)
          return c.json(await listAccounts(def))
        }),
      )
      .patch(
        '/:cli/accounts/:id',
        guard(async (c) => {
          const def = need(c)
          const { name = '' } = (await c.req.json().catch(() => ({}))) as { name?: string }
          const idx = await readIndex(def.id)
          const n = name.trim().slice(0, 60)
          if (!n) return c.json({ error: t('名字不能为空') }, 400)
          idx.accounts = idx.accounts.map((a) => (a.id === c.req.param('id') ? { ...a, name: n } : a))
          await writeIndex(def.id, idx)
          return c.json(await listAccounts(def))
        }),
      )
      .delete(
        '/:cli/accounts/:id',
        guard(async (c) => {
          const def = need(c)
          const id = c.req.param('id')
          const idx = await readIndex(def.id)
          idx.accounts = idx.accounts.filter((a) => a.id !== id)
          if (idx.active === id) idx.active = ''
          await writeIndex(def.id, idx)
          await rm(slotFile(def.id, id), { force: true })
          return c.json(await listAccounts(def))
        }),
      )
  )
}
