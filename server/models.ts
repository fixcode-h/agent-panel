import { readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS, type CliDefinition } from '../shared/clis.ts'
import type { CliModel, CliModels } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { capture, childEnv, runProcess } from './exec/process.ts'
import { getSettings } from './settings.ts'
import { resolveCommand } from './cli-source.ts'
import { detectClis } from './detect.ts'
import { t } from '../shared/i18n.ts'

/**
 * 从本机 CLI 读取可用的模型：内置列表跟不上 CLI 的更新，也不知道用户账号能用哪些模型。
 * - Codex：通过 `codex app-server` 的 model/list 请求（和 Codex 自己的 /model 菜单同一个来源）
 * - Command Code：`cmdc --list-models`
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
  const ac = new AbortController()
  const got: { list?: CliModel[]; account?: any; config?: any } = {}
  let rpcError = ''
  const req = (o: object) => JSON.stringify(o) + '\n'
  const r = await runProcess({
    command,
    args: ['app-server'],
    cwd: homedir(),
    env,
    signal: ac.signal,
    timeoutMs: 20_000,
    keepStdinOpen: true,
    stdin:
      req({ id: 0, method: 'initialize', params: { clientInfo: { name: 'agent-panel', version: '1' } } }) +
      req({ method: 'initialized' }) +
      req({ id: 2, method: 'account/read', params: {} }) +
      req({ id: 3, method: 'config/read', params: {} }) +
      req({ id: 1, method: 'model/list', params: { limit: 200 } }),
    onLine: (line) => {
      let msg: { id?: number; result?: any; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === 2) got.account = msg.error ? null : (msg.result ?? null)
      else if (msg.id === 3) got.config = msg.error ? null : (msg.result?.config ?? null)
      else if (msg.id === 1) {
        if (msg.error) rpcError = msg.error.message ?? t('未知错误')
        else
          got.list = (msg.result?.data ?? [])
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
      }
      // 三个都回来就停掉服务（旧版本不认识 account/read、config/read 时回的是错误，也算回来了）
      if ((got.list || rpcError) && got.account !== undefined && got.config !== undefined) ac.abort()
    },
  })
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
  if (r.spawnError) throw new Error(r.spawnError)
  if (r.killed === 'timeout') throw new Error(t('Codex 没有在 20 秒内返回模型列表'))
  throw new Error(r.stderr.trim().split('\n').at(-1) || t('Codex 退出了（退出码 {code}）', { code: String(r.code) }))
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
  const [r, st, windows] = await Promise.all([
    capture(command, ['--list-models'], homedir(), env, 30_000),
    capture(command, ['status'], homedir(), env, 15_000).catch(() => null),
    commandCodeWindows(command, env).catch(() => new Map<string, number>()),
  ])
  const models = parseCommandCodeModels(r.stdout).map((m) => {
    const w = windows.get(m.id) ?? windows.get(m.id.slice(m.id.lastIndexOf('/') + 1))
    return w ? { ...m, contextWindow: w } : m
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

/** 「1M」「256K」「1.05M」换成 token 数 */
export function parseContextSize(s: string) {
  const m = /^([\d.]+)\s*([KM])$/i.exec(s.trim())
  if (!m) return undefined
  return Math.round(Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1_000_000 : 1_000))
}

/** Command Code 安装包里的模型目录（reference/models.md）：表格的 Context 列是每个模型的上下文窗口 */
export function parseCommandCodeCatalog(md: string) {
  const out = new Map<string, number>()
  for (const line of md.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    const id = /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1]
    const w = id && parseContextSize(cells[3] ?? '')
    if (id && w) out.set(id, w)
  }
  return out
}

/**
 * Command Code 每个模型的上下文窗口。--list-models 不输出窗口，从两处补：
 * 安装包里随版本更新的模型目录，以及 ~/.commandcode/providers.json 里自己接的模型写的 contextWindow / limit.context。
 */
async function commandCodeWindows(command: string, env: NodeJS.ProcessEnv) {
  const out = new Map<string, number>()
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
        out.set(id, w)
        if (prefix) out.set(`${prefix}/${id}`, w)
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

export async function cliModels(id: string, refresh = false): Promise<CliModels> {
  const def = CLIS.find((c) => c.id === id)
  if (!def) throw new Error(t('未知的 CLI：{cli}', { cli: id }))
  const hit = cache.get(id)
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.data
  const cs = cliSettings(await getSettings(), id)
  const env = childEnv(cs.env)
  let data: CliModels
  // 没安装或停用的 CLI 不去启动它读模型，用内置列表
  const st = (await detectClis()).find((c) => c.id === id)
  if (!st?.installed || !cs.enabled) return { source: 'builtin', models: builtin(def), efforts: [] }
  try {
    if (def.modelsFrom === 'codex' || def.modelsFrom === 'commandcode') {
      const p =
        def.modelsFrom === 'codex' ? await codexModels(cs.command, env) : await commandCodeModels(cs.command, env)
      data = { source: 'cli', models: p.models, efforts: [], auth: p.auth, from: p.from }
    } else if (def.modelsFrom === 'claude') {
      const [auth, found] = await Promise.all([claudeAuth(cs.command, env), claudeConfigured(env)])
      const configured = found.map((m) => ({ ...m, origin: 'config' as const }))
      const base = builtin(def).map((m) => ({ ...m, origin: 'cli' as const }))
      // settings.json 里写了 model 时它才是默认
      if (configured.some((m) => m.isDefault)) base.forEach((m) => delete m.isDefault)
      data =
        auth === 'api' && configured.length
          ? { source: 'cli', models: [...configured, ...base], efforts: [], auth, from: t('settings.json / 环境变量') }
          : { source: 'builtin', models: [...base, ...configured], efforts: [], auth }
    } else {
      // 配置文件加的 CLI 没有列模型的命令，用配置里写的
      data = { source: 'builtin', models: builtin(def), efforts: [] }
    }
  } catch (e) {
    data = { source: 'builtin', models: builtin(def), efforts: [], error: (e as Error).message }
  }
  if (data.source === 'cli' && !data.models.length) data = { source: 'builtin', models: builtin(def), efforts: [] }
  data.models = uniq(data.models)
  data.efforts = [...new Set(data.models.flatMap((m) => m.efforts ?? []))]
  cache.set(id, { at: Date.now(), data })
  return data
}

/** Command Code 的上下文窗口只要读文件，不用跑 CLI，执行任务时模型列表还没读过也能查到 */
export async function knownWindows(id: string): Promise<Map<string, number>> {
  if (CLIS.find((c) => c.id === id)?.modelsFrom !== 'commandcode') return new Map()
  const cs = cliSettings(await getSettings(), id)
  return commandCodeWindows(cs.command, childEnv(cs.env)).catch(() => new Map())
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
