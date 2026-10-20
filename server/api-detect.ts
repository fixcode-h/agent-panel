/**
 * 识别各个 CLI 自己配置的 API（环境变量、配置文件里接的网关和密钥），交给设置页存进全局的 API 列表。
 * 在哪里读、键名是什么都写在 CLI 定义的 auth.apiSources 里，这里不按 CLI 的名字分支。
 * 只读不写；面板自己切到 API 方式时写进去的那一项（agentpanel）不算
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CLIS, type CliDefinition } from '../shared/clis.ts'
import {
  apiProvider,
  sameApi,
  type ApiConfig,
  type ApiProtocol,
  type ApiSource,
  type DetectedApi,
} from '../shared/accounts.ts'
import { cliSettings } from '../shared/settings.ts'
import { t } from '../shared/i18n.ts'
import { expandHome } from './cli-extras.ts'
import { childEnv } from './exec/process.ts'
import { parseToml } from './mcp-store.ts'
import { getSettings } from './settings.ts'

/** 面板改用 API 时写进 CLI 配置的提供方名字，见 shared/clis 里的 api.edits */
const PANEL_PROVIDER = 'agentpanel'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** .env 文件：KEY=VALUE 一行一个，# 开头是注释，值两边的引号去掉 */
export function parseDotenv(text: string): Obj {
  const out: Obj = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

async function readSource(src: ApiSource, env: NodeJS.ProcessEnv): Promise<[string, Obj][]> {
  let obj: unknown = env
  if (src.file) {
    const text = await readFile(expandHome(src.file), 'utf8').catch(() => '')
    if (!text.trim()) return []
    obj = src.format === 'toml' ? parseToml(text) : src.format === 'env' ? parseDotenv(text) : JSON.parse(text)
  }
  for (const k of src.at ? src.at.split('.') : []) obj = isObj(obj) ? obj[k] : undefined
  if (!isObj(obj)) return []
  return src.each ? Object.entries(obj).filter((e): e is [string, Obj] => isObj(e[1])) : [['', obj]]
}

/** 值写成 $NAME、${NAME}，或正好是一个设置了的环境变量名时取环境变量；!开头的是命令，读不出来 */
export function resolveValue(v: string, env: NodeJS.ProcessEnv) {
  const ref = /^\$\{?(\w+)\}?$/.exec(v)
  if (ref) return env[ref[1]] ?? ''
  if (/^[A-Z][A-Z0-9_]*$/.test(v) && env[v]) return env[v]!
  return v.startsWith('!') ? '' : v
}

const pick = (obj: Obj, keys: string[]) => {
  for (const k of keys) {
    const v = obj[k]
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim()
  }
  return ''
}

function modelsOf(obj: Obj, keys: string[]) {
  const out: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
    else if (Array.isArray(v))
      for (const x of v) {
        const id = typeof x === 'string' ? x : isObj(x) ? String(x.id ?? x.name ?? '') : ''
        if (id) out.push(id)
      }
    else if (isObj(v)) out.push(...Object.keys(v))
  }
  return [...new Set(out)]
}

/** 一条配置换成 API；什么都没配（没有密钥也没有自定义地址）时不算 */
export function toApi(
  def: CliDefinition,
  src: ApiSource,
  key: string,
  obj: Obj,
  env: NodeJS.ProcessEnv,
  skip: Set<string> = new Set([PANEL_PROVIDER]),
) {
  // 面板自己写进 CLI 配置的 provider 不算用户配置，否则会在「识别到的 API」里重复出现
  if (skip.has(key)) return null
  const bearer = resolveValue(pick(obj, src.bearerKey), env)
  const keyEnv = pick(obj, src.keyEnv)
  const apiKey = bearer || resolveValue(pick(obj, src.apiKey), env) || (keyEnv ? (env[keyEnv] ?? '') : '')
  const url = resolveValue(pick(obj, src.baseUrl), env)
  if (!apiKey && !url) return null
  const wire = pick(obj, src.wireKey)
  const map: Record<string, ApiProtocol> = Object.keys(src.wire).length
    ? src.wire
    : Object.fromEntries(Object.entries(def.auth?.api?.wire ?? {}).map(([p, w]) => [w, p as ApiProtocol]))
  const name = pick(obj, src.name) || key
  const api: ApiConfig = {
    id: createHash('sha1').update(`${def.id}\n${src.file}\n${src.at}\n${key}`).digest('hex').slice(0, 8),
    name: (name ? `${def.name} · ${name}` : def.name).slice(0, 60),
    // each 的 key 就是 CLI 配置里的 provider 名（如 providers.tokenapi）；不是 each 的来源没有
    provider: key,
    protocol: map[wire] ?? src.protocol,
    baseUrl: url || src.defaultBaseUrl,
    apiKey,
    authHeader: bearer ? 'bearer' : 'x-api-key',
    models: modelsOf(obj, src.models),
  }
  return api
}

/** 所有 CLI 里识别到的 API；同一个（协议、地址、密钥一样）只留第一个，模型合在一起 */
export async function detectApis(): Promise<DetectedApi[]> {
  const settings = await getSettings()
  const skip = new Set([PANEL_PROVIDER, ...settings.apis.map((a) => apiProvider(a))])
  const out: DetectedApi[] = []
  for (const def of CLIS) {
    if (!def.auth?.apiSources.length) continue
    // 按账号方式的环境来：API 方式时面板加给 CLI 的环境变量不算 CLI 自己的配置
    const cs = cliSettings(
      { ...settings, clis: { ...settings.clis, [def.id]: { ...settings.clis[def.id], authMode: 'account' } } as any },
      def.id,
    )
    const env = childEnv(cs.env)
    for (const src of def.auth.apiSources) {
      const entries = await readSource(src, env).catch(() => [] as [string, Obj][])
      for (const [key, obj] of entries) {
        const api = toApi(def, src, key, obj, env, skip)
        if (!api) continue
        const dup = out.find((d) => sameApi(d.api, api))
        if (dup) dup.api.models = [...new Set([...dup.api.models, ...api.models])]
        else out.push({ cli: def.id, source: src.file ? expandHome(src.file) : t('环境变量'), api })
      }
    }
  }
  return out
}
