import { readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS, type CliDefinition } from '../shared/clis.ts'
import { RpcSpec } from '../shared/cli-spec.ts'
import type { CliModel, CliModels } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { modelLimitsFor, type ModelCatalogEntry } from '../shared/model-catalog.ts'
import {
  apiModelList,
  apiModelPrefix,
  modelsForProtocol,
  type ApiConfig,
  type ApiProtocol,
} from '../shared/accounts.ts'
import { mergedModelCatalog } from './model-catalog-store.ts'
import { capture, childEnv } from './exec/process.ts'
import { rpcQuery } from './exec/rpc/query.ts'
import { getSettings } from './settings.ts'
import { resolveCommand } from './cli-source.ts'
import { detectClis } from './detect.ts'
import { t } from '../shared/i18n.ts'

/**
 * 从本机 CLI 读取可用的模型：内置列表跟不上 CLI 的更新，也不知道用户账号能用哪些模型。
 * - Codex：通过 `codex app-server` 的 model/list 请求（和 Codex 自己的 /model 菜单同一个来源）
 * - Command Code：`cmdc --list-models`
 * - Pi：`pi --list-models`
 * - Claude Code：没有列出模型的命令，用内置的型号（opus / sonnet 这类别名不列，和具体型号重复），再加上用户在环境变量、settings.json 里配置的模型
 */

const TTL = 10 * 60_000
const cache = new Map<string, { at: number; data: CliModels }>()

const builtin = (def: CliDefinition): CliModel[] =>
  def.models.map((m) => ({ id: m.id, label: m.label, isDefault: m.isDefault }))

/** 按 id 去重，先出现的优先 */
function uniq(models: CliModel[]) {
  const seen = new Map<string, CliModel>()
  return models.filter((m) => {
    const first = seen.get(m.id)
    // 重复出现时保留默认标记（例如 settings.json 里把 opus 设成了默认）
    if (first) first.isDefault ||= m.isDefault
    else seen.set(m.id, m)
    return !first
  })
}

type Picked = { models: CliModel[]; auth?: 'account' | 'api'; from?: string }

/**
 * Codex：同一个 app-server 里读账号（account/read）、配置（config/read）和模型列表（model/list）。
 * ChatGPT 账号登录时用 model/list，就是账号能用的模型；API Key 或自定义 model_provider 时
 * model/list 只是内置预设，改用 config.toml 里配的模型（model、review_model、各 profile 的 model）。
 */
async function codexModels(command: string, env: NodeJS.ProcessEnv): Promise<Picked> {
  const got: { list?: CliModel[]; account?: any; config?: any } = {}
  const def = CLIS.find((c) => c.id === 'codex')
  const rpc = RpcSpec.parse(def?.rpc ?? {})
  // 和任务执行共用同一条 RPC 会话引擎：握手、请求配对、超时和收尾都一样
  const r = await rpcQuery({
    command,
    args: rpc.queryArgs,
    cwd: homedir(),
    env,
    handshake: rpc.handshake,
    jsonrpc: rpc.jsonrpc,
    requests: [
      // 旧版本的 Codex 不认识这两个请求，回错误或没有响应也继续读模型列表
      { method: 'account/read', params: {}, timeoutMs: 3000 },
      { method: 'config/read', params: {}, timeoutMs: 3000 },
      { method: 'model/list', params: { limit: 200 } },
    ],
  })
  const accountReply = r[0]
  const configReply = r[1]
  const listReply = r[2]
  got.account = accountReply?.error ? null : (accountReply?.result ?? null)
  got.config = configReply?.error ? null : (configReply?.result?.config ?? null)
  let rpcError = ''
  if (listReply?.error) rpcError = listReply.error.message ?? t('未知错误')
  else
    got.list = (listReply?.result?.data ?? [])
      .map((x: unknown) => x as Record<string, any>)
      .filter((m: Record<string, any>) => !m.hidden && typeof m.id === 'string')
      .map((m: Record<string, any>) => ({
        id: m.model || m.id,
        label: m.displayName || m.id,
        description: m.description || undefined,
        efforts: Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort).filter(Boolean)
          : undefined,
        isDefault: !!m.isDefault || undefined,
        defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : undefined,
      }))
  const configured = codexConfigured(got.config).map((m) => ({ ...m, origin: 'config' as const }))
  const listed = (got.list ?? []).map((m) => ({ ...m, origin: 'cli' as const }))
  const account = got.account?.account
  const api =
    account?.type !== 'chatgpt' &&
    !!(account || got.account?.requiresOpenaiAuth === false || got.config?.model_provider)
  // config.toml 里写了 model 时它才是 Codex 实际用的默认模型
  if (configured.some((m) => m.isDefault)) listed.forEach((m) => delete m.isDefault)
  if (got.list || configured.length)
    return {
      // 用 API / 自定义接口时 model/list 只是内置预设，配置文件里的排前面
      models: api ? [...configured, ...listed] : [...listed, ...configured],
      auth: account?.type === 'chatgpt' ? 'account' : api ? 'api' : undefined,
      from: account?.type === 'chatgpt' ? t('ChatGPT 账号') : configured.length ? 'config.toml' : undefined,
    }
  if (rpcError) throw new Error(t('Codex 返回错误：{error}', { error: rpcError }))
  throw new Error(t('Codex 没有返回模型列表'))
}

/** config.toml 里配的模型：顶层 model 是默认，其次 review_model 和各 profile 的 model */
export function codexConfigured(config: any): CliModel[] {
  if (!config || typeof config !== 'object') return []
  const out: CliModel[] = []
  const effort = typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : undefined
  if (typeof config.model === 'string' && config.model)
    out.push({
      id: config.model,
      label: config.model,
      description: t('默认模型（config.toml）'),
      isDefault: true,
      defaultEffort: effort,
    })
  if (typeof config.review_model === 'string' && config.review_model)
    out.push({ id: config.review_model, label: config.review_model, description: t('审查用的模型（review_model）') })
  for (const [name, p] of Object.entries((config.profiles ?? {}) as Record<string, any>))
    if (p && typeof p.model === 'string' && p.model)
      out.push({
        id: p.model,
        label: p.model,
        description: `profile「${name}」`,
        defaultEffort: typeof p.model_reasoning_effort === 'string' ? p.model_reasoning_effort : undefined,
      })
  return uniq(out)
}

/** 解析 `cmdc --list-models`：分组标题单独一行，模型行是「id  两个以上空格  说明」 */
export function parseCommandCodeModels(out: string): CliModel[] {
  const models: CliModel[] = []
  let group = ''
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    // 后面是用法说明和只能在无界面模式用的模型，不是可选的编码模型
    if (/^Pass the full id/i.test(line) || /^Decision models/i.test(line)) break
    if (!line.trim() || /^Available models/i.test(line) || /^Updated /.test(line)) continue
    const m = /^([A-Za-z0-9][\w.\-/:]*)\s{2,}(\S.*)$/.exec(line)
    if (m) {
      const isDefault = /\(default\)/i.test(m[2])
      models.push({
        id: m[1],
        label: m[1],
        description: m[2].replace(/\s*\(default\)\s*/i, ' ').trim(),
        group,
        ...(isDefault && { isDefault }),
      })
    } else if (!/\s{2,}/.test(line) && !line.startsWith(' ')) group = line.trim()
  }
  return models
}

/**
 * Command Code：`cmdc status` 判断有没有登录 Command Code 账号。登录了就列出全部模型（账号的加上自己接的 BYOK）；
 * 没登录只能用 ~/.commandcode/providers.json 里接的 BYOK 接口，只列这些。
 */
async function commandCodeModels(command: string, env: NodeJS.ProcessEnv): Promise<Picked> {
  const [r, st, catalog] = await Promise.all([
    capture(command, ['--list-models'], homedir(), env, 30_000),
    capture(command, ['status'], homedir(), env, 15_000).catch(() => null),
    commandCodeCatalog(command, env).catch(() => new Map<string, CatalogInfo>()),
  ])
  const models = parseCommandCodeModels(r.stdout).map((m) => {
    const info = catalog.get(m.id) ?? catalog.get(m.id.slice(m.id.lastIndexOf('/') + 1))
    if (!info) return m
    // 目录里写了窗口和思考强度就用它：模型不认的强度 CLI 会启动即报错退出，下拉里不能再给
    return {
      ...m,
      ...(info.window ? { contextWindow: info.window } : {}),
      ...(info.efforts ? { efforts: info.efforts } : {}),
    }
  })
  if (!models.length) {
    if (r.spawnError) throw new Error(r.spawnError)
    throw new Error((r.stderr || r.stdout).trim().split('\n').at(-1) || t('退出码 {code}', { code: String(r.code) }))
  }
  const status = (st?.stdout ?? '') + (st?.stderr ?? '')
  const loggedOut = /not authenticated|not logged in|未登录/i.test(status)
  // providers.json 里自己接的接口（BYOK）算配置文件里的模型，其余是 Command Code 账号的
  const tagged = models.map((m) => ({ ...m, origin: /\(byok\)/i.test(m.group ?? '') ? 'config' : 'cli' }) as CliModel)
  const byok = tagged.filter((m) => m.origin === 'config')
  if (!loggedOut)
    return {
      models: tagged,
      auth: st && !st.spawnError && st.code === 0 ? 'account' : undefined,
      from: t('Command Code 账号'),
    }
  // 没登录只能用 BYOK；没接 BYOK 时还是给出全部，否则下拉是空的，真正执行时 CLI 会提示登录
  return byok.length ? { models: byok, auth: 'api', from: 'providers.json' } : { models: tagged, auth: 'api' }
}

/**
 * Pi：`pi --list-models` 列出配好了凭据的提供方的模型（环境变量、auth.json、models.json 里自己接的都算），
 * 一行一个：provider、model、context、max-out、thinking、images。模型写成 provider/model，Pi 的 --model 认这种写法
 */
export function parsePiModels(out: string, efforts: string[]): CliModel[] {
  const models: CliModel[] = []
  for (const raw of out.split('\n')) {
    const cells = raw
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
      .split(/\s+/)
    if (cells.length < 5 || cells[0] === 'provider') continue
    const [provider, model, context, maxOut, thinking] = cells
    const w = parseContextSize(context)
    const out = parseContextSize(maxOut)
    // 只认表格里的行：上下文是「200K」这样的大小，thinking 列是 yes / no（提示文字不是模型）
    if (!w || !/^(yes|no)$/.test(thinking)) continue
    models.push({
      id: `${provider}/${model}`,
      label: model,
      group: provider,
      contextWindow: w,
      ...(out ? { maxOutput: out } : {}),
      // 不支持思考的模型不给思考强度，选了 Pi 也会忽略
      efforts: thinking === 'yes' ? efforts : [],
    })
  }
  return models
}

async function piModels(def: CliDefinition, command: string, env: NodeJS.ProcessEnv): Promise<Picked> {
  // --offline：只读本机的模型表，不去联网检查更新
  const r = await capture(command, ['--list-models', '--offline'], homedir(), env, 30_000)
  // Pi 的模型表写在 stderr（stdout 是空的），错误信息和提示也在 stderr，合起来解析
  const text = [r.stdout, r.stderr].filter((s) => s.trim()).join('\n')
  const models = parsePiModels(
    text,
    def.efforts.map((e) => e.id),
  )
  if (!models.length) {
    if (r.spawnError) throw new Error(r.spawnError)
    const msg = text.trim().split('\n').at(-1)
    // 一个提供方都没配时 Pi 只说没有模型，这时用内置的建议
    if (r.code === 0) return { models: [] }
    throw new Error(msg || t('退出码 {code}', { code: String(r.code) }))
  }
  return { models, from: t('Pi 已配置的提供方') }
}

/** 「1M」「256K」「1.05M」换成 token 数 */
export function parseContextSize(s: string) {
  const m = /^([\d.]+)\s*([KM])$/i.exec(s.trim())
  if (!m) return undefined
  return Math.round(Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1_000_000 : 1_000))
}

/** 模型目录里的一条：上下文窗口和能用的思考强度（目录里没有的项不写） */
export type CatalogInfo = { window?: number; efforts?: string[] }

/**
 * Command Code 安装包里的模型目录（reference/models.md）：Context 列是上下文窗口，
 * Efforts 列是这个模型能用的思考强度（「—」表示不支持思考，列不认识时当不知道）。
 * 表格列：Id | Name | Context | Efforts | $/1M in/out | Min plan | Best for
 */
export function parseCommandCodeCatalog(md: string): Map<string, CatalogInfo> {
  const out = new Map<string, CatalogInfo>()
  for (const line of md.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    const id = /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1]
    if (!id) continue
    const info: CatalogInfo = {}
    const w = parseContextSize(cells[3] ?? '')
    if (w) info.window = w
    const cell = cells[4] ?? ''
    // 只认「off, low, high」和「—」这种写法；目录改版、这一列是别的内容时当不知道，不当成强度
    const efforts = /^[—–-]$/.test(cell)
      ? []
      : /^[a-z][a-z0-9]*(\s*,\s*[a-z][a-z0-9]*)*$/i.test(cell)
        ? cell.split(',').map((s) => s.trim())
        : undefined
    if (efforts) info.efforts = efforts
    if (info.window || efforts) out.set(id, info)
  }
  return out
}

/**
 * Command Code 每个模型的上下文窗口和思考强度。--list-models 不输出这些，从两处补：
 * 安装包里随版本更新的模型目录，以及 ~/.commandcode/providers.json 里自己接的模型写的 contextWindow / limit.context。
 */
async function commandCodeCatalog(command: string, env: NodeJS.ProcessEnv) {
  const out = new Map<string, CatalogInfo>()
  const pkg = packageDir(command, env, 'command-code')
  if (pkg) {
    const md = await readFile(path.join(pkg, 'dist/bundled/command-code-knowledge/reference/models.md'), 'utf8').catch(
      () => '',
    )
    for (const [k, v] of parseCommandCodeCatalog(md)) out.set(k, v)
  }
  try {
    const p = JSON.parse(await readFile(path.join(homedir(), '.commandcode', 'providers.json'), 'utf8'))
    // 结构因版本而异，按「带 contextWindow 的模型对象」找，键名或 id 都记上
    const walk = (v: any, key: string, prefix: string) => {
      if (!v || typeof v !== 'object') return
      const w = Number(v.contextWindow ?? v.limit?.context)
      const id = typeof v.id === 'string' ? v.id : key
      if (w > 0 && id) {
        out.set(id, { ...out.get(id), window: w })
        if (prefix) out.set(`${prefix}/${id}`, { ...out.get(`${prefix}/${id}`), window: w })
      }
      for (const [k, c] of Object.entries(v)) walk(c, Array.isArray(v) ? '' : k, key && !w ? key : prefix)
    }
    walk(p, '', '')
  } catch {}
  return out
}

/** 命令对应的 npm 包目录：顺着可执行文件（符号链接）往上找，Windows 的 .cmd 包装在 npm 前缀下的 node_modules 里 */
function packageDir(command: string, env: NodeJS.ProcessEnv, name: string) {
  const file = resolveCommand(command, env)
  if (!file) return undefined
  const has = (d: string) => {
    try {
      return JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')).name === name
    } catch {
      return false
    }
  }
  let d = path.dirname(realpathSafe(file))
  for (let i = 0; i < 6; i++, d = path.dirname(d)) if (has(d)) return d
  const near = [
    path.join(path.dirname(file), 'node_modules', name),
    path.join(path.dirname(file), '..', 'lib', 'node_modules', name),
  ]
  return near.find(has)
}

const realpathSafe = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Claude Code 用户自己配置的模型（第三方网关、固定版本等） */
async function claudeConfigured(env: NodeJS.ProcessEnv): Promise<CliModel[]> {
  const found: CliModel[] = []
  const keys: [string, string][] = [
    ['ANTHROPIC_MODEL', t('环境变量 ANTHROPIC_MODEL')],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', t('opus 对应的模型')],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', t('sonnet 对应的模型')],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', t('haiku 对应的模型')],
  ]
  let settingsEnv: Record<string, string> = {}
  try {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
    const s = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))
    settingsEnv = s.env ?? {}
    if (typeof s.model === 'string' && s.model)
      found.push({ id: s.model, label: s.model, description: t('settings.json 里的默认模型'), isDefault: true })
  } catch {}
  for (const [k, desc] of keys) {
    const v = env[k] || settingsEnv[k]
    if (v) found.push({ id: v, label: v, description: desc })
  }
  return found
}

/**
 * Claude Code 的登录方式：`claude auth status` 输出 JSON。claude.ai 账号（订阅）登录时能用全部内置型号；
 * API Key、apiKeyHelper、Bedrock / Vertex 或自定义 ANTHROPIC_BASE_URL 时只列配置里写的模型。
 */
async function claudeAuth(command: string, env: NodeJS.ProcessEnv): Promise<'account' | 'api' | undefined> {
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'api'
  const r = await capture(command, ['auth', 'status'], homedir(), env, 15_000).catch(() => null)
  try {
    const s = JSON.parse(r?.stdout ?? '')
    if (s.apiProvider && s.apiProvider !== 'firstParty') return 'api'
    if (/api.?key/i.test(String(s.authMethod ?? ''))) return 'api'
    if (s.loggedIn) return 'account'
  } catch {}
  return undefined
}

/**
 * 用模型目录补齐 CLI 没有报告的项：上下文窗口、最大输出、可选思考强度和默认强度。
 * 目录里没有的模型保持原样，执行时按 1M / 128K 估算，思考强度交给 CLI 自己判断。
 */
function withCatalog(
  models: CliModel[],
  entries: ModelCatalogEntry[],
  allowed: string[],
  protocol?: ApiProtocol,
): CliModel[] {
  return models.map((m) => {
    const info = modelLimitsFor(m.id, { entries, protocol })
    if (!info.matched || !info.entry) return m
    const entry = info.entry
    // 只保留这个 CLI 认识的强度 id；目录里有、CLI 没有的不往下拉里放
    const efforts = allowed.length ? entry.efforts.filter((e) => allowed.includes(e)) : entry.efforts
    const defaultEffort = efforts.includes(entry.defaultEffort) ? entry.defaultEffort : (efforts[0] ?? '')
    return {
      ...m,
      contextWindow: m.contextWindow ?? entry.context,
      maxOutput: m.maxOutput ?? entry.maxOutput,
      ...(m.efforts ? {} : { efforts }),
      ...(m.defaultEffort ? {} : { defaultEffort: defaultEffort || undefined }),
    }
  })
}

/** API 模式：用全局 API 里配的模型，并按 CLI 的要求补 provider 前缀 */
function apiModelsFor(def: CliDefinition, api: ApiConfig): CliModels {
  const prefix = apiModelPrefix(def.auth, api)
  // 按协议只列匹配后缀的模型；不带后缀的通用模型都列
  const list = modelsForProtocol(apiModelList(api, prefix), api.protocol)
  return {
    source: 'builtin',
    models: list.map((m, i) => ({
      id: m,
      label: m,
      isDefault: i === 0 || undefined,
      origin: 'config' as const,
    })),
    efforts: [],
    auth: 'api',
    from: api.name,
  }
}

/** 从 CLI 自己的配置/列表读模型 */
async function modelsFromCli(
  def: CliDefinition,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<CliModels | undefined> {
  if (def.modelsFrom === 'codex' || def.modelsFrom === 'commandcode') {
    const p = def.modelsFrom === 'codex' ? await codexModels(command, env) : await commandCodeModels(command, env)
    return { source: 'cli', models: p.models, efforts: [], auth: p.auth, from: p.from }
  }
  if (def.modelsFrom === 'pi') {
    const p = await piModels(def, command, env)
    return { source: 'cli', models: p.models, efforts: [], from: p.from }
  }
  if (def.modelsFrom === 'claude') {
    const [auth, found] = await Promise.all([claudeAuth(command, env), claudeConfigured(env)])
    const configured = found.map((m) => ({ ...m, origin: 'config' as const }))
    const base = builtin(def).map((m) => ({ ...m, origin: 'cli' as const }))
    // settings.json 里写了 model 时它才是默认
    if (configured.some((m) => m.isDefault)) base.forEach((m) => delete m.isDefault)
    return auth === 'api' && configured.length
      ? { source: 'cli', models: [...configured, ...base], efforts: [], auth, from: t('settings.json / 环境变量') }
      : { source: 'builtin', models: [...base, ...configured], efforts: [], auth }
  }
  return undefined
}

export async function cliModels(id: string, refresh = false): Promise<CliModels> {
  const def = CLIS.find((c) => c.id === id)
  if (!def) throw new Error(t('未知的 CLI：{cli}', { cli: id }))
  const cs = cliSettings(await getSettings(), id)
  const entries = await mergedModelCatalog().catch(() => [])
  const protocol = cs.api?.protocol
  const applyCatalog = (data: CliModels) => {
    data.models = withCatalog(
      uniq(data.models),
      entries,
      def.efforts.map((e) => e.id),
      protocol,
    )
    data.efforts = [...new Set(data.models.flatMap((m) => m.efforts ?? []))]
    return data
  }

  if (cs.api) {
    const fallback = apiModelsFor(def, cs.api)
    const spec = def.auth?.api
    // 能写进 CLI 配置、CLI 也能列模型的（Command Code、Pi），只取 API 里配的那几个模型；
    // 配置文件里以前留下的其他模型不再显示。
    if (spec?.modelSource !== 'cli' || !def.modelsFrom) return applyCatalog(fallback)
    const st = (await detectClis()).find((c) => c.id === id)
    if (!st?.installed || !cs.enabled) return applyCatalog(fallback)
    try {
      const listed = await modelsFromCli(def, cs.command, childEnv(cs.env))
      if (!listed) return applyCatalog(fallback)
      const byId = new Map(listed.models.map((m) => [m.id, m]))
      const models = fallback.models.map((m) => {
        const hit = byId.get(m.id)
        return hit ? { ...hit, id: m.id, isDefault: m.isDefault } : m
      })
      return applyCatalog({ ...fallback, source: listed.source, models, from: cs.api.name })
    } catch {
      return applyCatalog(fallback)
    }
  }

  const hit = cache.get(id)
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.data
  const env = childEnv(cs.env)
  // 没安装或停用的 CLI 不去启动它读模型，用内置列表
  const st = (await detectClis()).find((c) => c.id === id)
  if (!st?.installed || !cs.enabled) return { source: 'builtin', models: builtin(def), efforts: [] }
  let data: CliModels
  try {
    data = (await modelsFromCli(def, cs.command, env)) ?? { source: 'builtin', models: builtin(def), efforts: [] }
  } catch (e) {
    data = { source: 'builtin', models: builtin(def), efforts: [], error: (e as Error).message }
  }
  if (data.source === 'cli' && !data.models.length) data = { source: 'builtin', models: builtin(def), efforts: [] }
  data = applyCatalog(data)
  cache.set(id, { at: Date.now(), data })
  return data
}

/** Command Code 的上下文窗口只要读文件，不用跑 CLI，执行任务时模型列表还没读过也能查到 */
export async function knownWindows(id: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const [k, v] of await knownCatalog(id)) if (v.window) out.set(k, v.window)
  return out
}

/** 这个 CLI 的模型目录（目前只有 Command Code 有）；读不到时是空的 */
async function knownCatalog(id: string): Promise<Map<string, CatalogInfo>> {
  if (CLIS.find((c) => c.id === id)?.modelsFrom !== 'commandcode') return new Map()
  const cs = cliSettings(await getSettings(), id)
  return commandCodeCatalog(cs.command, childEnv(cs.env)).catch(() => new Map<string, CatalogInfo>())
}

/** CLI 明确说过不能调整思考强度的模型：进程内记住，之后不再传 */
const noEffort = new Set<string>()
const noEffortKey = (cli: string, model: string) => `${cli}\n${model}`
export const markNoEffort = (cli: string, model: string) => noEffort.add(noEffortKey(cli, model))

/**
 * 执行前挡一下模型不认的思考强度：CLI 会启动即报错退出（退出码 1），整个任务就白跑了。
 * 依据是 CLI 报的模型列表（Codex、Pi、Command Code）和 Command Code 安装包里的模型目录；
 * 这个模型不知道该怎么判时照原样传，交给 CLI 自己决定。
 */
export async function supportedEffort(id: string, model: string, effort?: string): Promise<string> {
  if (!effort || !model) return effort ?? ''
  // CLI 已经说过这个模型不能调强度（自定义接口的模型常这样）：之后都不传
  if (noEffort.has(noEffortKey(id, model))) return ''
  const known = new Map<string, string[]>()
  for (const m of cachedModels(id)?.models ?? []) if (m.efforts) known.set(m.id, m.efforts)
  for (const [k, v] of await knownCatalog(id).catch(() => new Map<string, CatalogInfo>()))
    if (v.efforts) known.set(k, v.efforts)
  // 模型目录里的可选强度：CLI 没报告时用这个挡住模型不认的值；
  // API 设置里给这个模型配了映射时按映射到的模型算
  const catalog = await mergedModelCatalog().catch(() => [])
  const cs = cliSettings(await getSettings(), id)
  const hit = modelLimitsFor(cs.api?.modelMap?.[model] || model, { entries: catalog })
  if (hit.matched && hit.entry) {
    const allowed = CLIS.find((c) => c.id === id)?.efforts.map((e) => e.id) ?? []
    known.set(model, allowed.length ? hit.entry.efforts.filter((e) => allowed.includes(e)) : hit.entry.efforts)
  }
  if (!known.size) return effort
  // 模型名可能写成完整的 id，也可能只有后半段（providers.json 里自己接的）
  const list = known.get(model) ?? known.get(model.slice(model.lastIndexOf('/') + 1))
  return !list || list.includes(effort) ? effort : ''
}

/** 已经读过的模型列表（不触发读取）：执行任务时查上下文窗口用，不能为此再去跑一次 CLI */
export const cachedModels = (id: string) => cache.get(id)?.data

export const invalidateModels = (id?: string) => (id ? cache.delete(id) : cache.clear())

export function modelsApi() {
  return new Hono().get('/:id/models', async (c) => {
    const id = c.req.param('id')
    if (!CLIS.some((x) => x.id === id)) return c.json({ error: t('未知的 CLI：{cli}', { cli: id }) }, 404)
    return c.json(await cliModels(id, c.req.query('refresh') === '1'))
  })
}
