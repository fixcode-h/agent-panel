/**
 * 模型目录：厂商、模型类型、版本、协议、上下文窗口、最大输出和档位。
 *
 * 模型名匹配规则（用户粘贴的模型常常带网关、provider、协议和速度后缀）：
 * 1. 只取最后一段（`tokenapi/deepseek/deepseek-v4-flash` → `deepseek-v4-flash`）
 * 2. 去掉协议后缀（`-responses`、`-chat`、`-anthropic`、`-gemini`）和速度 / 预览后缀（`-fast`、`-turbo`、`-preview`）
 * 3. 用 `-` 分开后的第一个词做厂商初筛（`deepseek`、`claude`、`gpt`、`qwen`……）
 * 4. 模型类型（`flash`、`pro`、`max`、`opus`……）比版本（`v4`、`5.5`……）优先：
 *    目录里只有 `deepseek-flash` 和 `deepseek-v4-pro` 时，`deepseek-v4-flash` 匹配 `deepseek-flash`
 * 5. 当前 API 的协议（OpenAI Responses / Chat、Anthropic、Gemini）优先选择支持它的模型
 */
import { z } from 'zod'
import { API_PROTOCOLS, type ApiProtocol } from './accounts.ts'
import type { ModelTier } from './clis.ts'
import raw from './model-catalog.json'

/** 目录里没有的模型按这个估算 */
export const DEFAULT_MODEL_CONTEXT = 1_000_000
export const DEFAULT_MODEL_MAX_OUTPUT = 128_000

export const MODEL_TIER_NAMES = ['high', 'medium', 'low'] as const

export const ModelCatalogEntry = z.object({
  /** 厂商，例如 anthropic、openai、deepseek、moonshot、zhipu、alibaba */
  vendor: z.string().trim().min(1),
  /** 模型 id（不带 provider 前缀） */
  id: z.string().trim().min(1),
  label: z.string().trim().default(''),
  /** 模型类型，例如 flash、pro、max、opus；没有类型时写 general */
  type: z.string().trim().default('general'),
  /** 版本，例如 4、5.5、k3；没有版本时留空 */
  version: z.string().trim().default(''),
  /** 这个模型支持的协议 */
  protocols: z.array(z.enum(API_PROTOCOLS)).default([]),
  context: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  /** 可选思考强度；和 CLI 的 efforts id 一致，不支持思考时是空数组 */
  efforts: z.array(z.string().trim().min(1)).default([]),
  /** 这个模型默认用的思考强度 */
  defaultEffort: z.string().trim().default(''),
  /**
   * 能不能看图片。CLI 会读自己配置里的模型条目决定要不要把图片发给模型（Pi 看 input 里有没有 image），
   * 面板写回配置时要照这个值写；不写表示目录里还没登记，按不支持处理
   */
  images: z.boolean().optional(),
  tier: z.enum(MODEL_TIER_NAMES).default('medium'),
  /** 其他可以匹配到这条记录的写法 */
  aliases: z.array(z.string().trim().min(1)).default([]),
  /** 信息来源（官方文档地址）；内置目录里没有，AI 补全的会写上 */
  source: z.string().trim().default(''),
})
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>

export const ModelCatalogFile = z.object({
  updated: z.string().default(''),
  models: z.array(ModelCatalogEntry).default([]),
})
export type ModelCatalogFile = z.infer<typeof ModelCatalogFile>

export const BUILTIN_MODEL_CATALOG: ModelCatalogEntry[] = ModelCatalogFile.parse(raw).models

/** 用户补充的目录覆盖内置目录里同一个厂商的同名模型 */
export function mergeCatalog(builtin: ModelCatalogEntry[], extra: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const key = (m: ModelCatalogEntry) => `${m.vendor.toLowerCase()}:${m.id.toLowerCase()}`
  const out = new Map(builtin.map((m) => [key(m), m]))
  for (const m of extra) out.set(key(m), m)
  return [...out.values()]
}

const VENDORS: Record<string, string> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  gpt: 'openai',
  codex: 'openai',
  google: 'google',
  gemini: 'google',
  deepseek: 'deepseek',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  kimi: 'moonshot',
  zhipu: 'zhipu',
  zai: 'zhipu',
  'zai-org': 'zhipu',
  glm: 'zhipu',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  qwq: 'alibaba',
  tongyi: 'alibaba',
  dashscope: 'alibaba',
  tencent: 'tencent',
  hunyuan: 'tencent',
  xiaomi: 'xiaomi',
  mimo: 'xiaomi',
  bytedance: 'bytedance',
  doubao: 'bytedance',
  seed: 'bytedance',
  volcengine: 'bytedance',
  baidu: 'baidu',
  ernie: 'baidu',
  wenxin: 'baidu',
  minimax: 'minimax',
  abab: 'minimax',
  xai: 'xai',
  grok: 'xai',
  mistral: 'mistral',
  magistral: 'mistral',
  codestral: 'mistral',
  meta: 'meta',
  llama: 'meta',
  cohere: 'cohere',
  command: 'cohere',
  stepfun: 'stepfun',
  step: 'stepfun',
}

/** 模型的类型词，和版本无关；匹配时类型优先于版本 */
const TYPE_ALIASES: Record<string, string> = {
  reasoner: 'reasoning',
  reasoning: 'reasoning',
  think: 'reasoning',
  thinking: 'reasoning',
  instruct: 'general',
  chat: 'general',
  base: 'general',
  standard: 'general',
  code: 'coder',
  coding: 'coder',
  coder: 'coder',
}
const EXTRA_TYPES = [
  'pro',
  'flash',
  'max',
  'plus',
  'ultra',
  'mini',
  'nano',
  'lite',
  'air',
  'edge',
  'compact',
  'large',
  'small',
  'general',
  'reasoning',
  'coder',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'astra',
  'sol',
  'luna',
  't1',
]

/** 表示速度的后缀：匹配类型时忽略（`deepseek-v4-flash-fast` 里的 fast） */
const SPEED = new Set(['fast', 'faster', 'fastest', 'turbo', 'turbos', 'speed', 'speedy', 'rapid', 'instant', 'quick'])
/** 预览、实验等后缀，不是模型类型 */
const QUALIFIER = new Set(['exp', 'experimental', 'preview', 'beta', 'rc', 'latest', 'stable', 'nightly', 'dev'])
const DATE = /^(?:20\d{6}|\d{4}-\d{2}-\d{2}|\d{6})$/

const PROTOCOL_SUFFIXES: [RegExp, ApiProtocol][] = [
  [/-chat-completions$/i, 'openai-chat'],
  [/-completions$/i, 'openai-chat'],
  [/-responses$/i, 'openai-responses'],
  [/-anthropic$/i, 'anthropic'],
  [/-messages$/i, 'anthropic'],
  [/-gemini$/i, 'gemini'],
  [/-chat$/i, 'openai-chat'],
]

const VERSION = /^(?:v|k|m)?(\d+(?:\.\d+)*)$/i
const EMBEDDED_VENDOR = /^([a-z]+?)(\d+(?:\.\d+)*)$/i

const numbers = (s: string) => s.split('.').map((n) => Number(n))

/** 目录记录的 version 字段只在 id 里没写版本时用来比较 */
const parseVersion = (v: string) => {
  const m = /^(?:v|k|m)?(\d+(?:\.\d+)*)$/i.exec(v.trim())
  return m ? numbers(m[1]) : []
}

function vendorOf(token: string | undefined): string | undefined {
  if (!token) return undefined
  const t = token.toLowerCase()
  if (VENDORS[t]) return VENDORS[t]
  if (/^o\d+$/.test(t)) return 'openai'
  const m = EMBEDDED_VENDOR.exec(t)
  return m ? VENDORS[m[1]] : undefined
}

function typeSetOf(entries: ModelCatalogEntry[]) {
  const out = new Set<string>(EXTRA_TYPES)
  for (const e of entries) {
    out.add(normalizeType(e.type))
    for (const a of e.aliases) out.add(normalizeType(a))
  }
  for (const k of Object.keys(TYPE_ALIASES)) out.add(k)
  return out
}

const normalizeType = (s: string) => TYPE_ALIASES[s.trim().toLowerCase()] ?? s.trim().toLowerCase()

export interface NormalizedModel {
  /** 最后一段原文 */
  bare: string
  /** 去掉协议、速度等后缀后的名字，用来判断是不是同一条记录 */
  canonical: string
  vendor?: string
  /** 版本的数字部分，例如 5.5 → [5, 5] */
  version: number[]
  types: Set<string>
  protocols: ApiProtocol[]
  speed: boolean
}

/** 把模型名拆成厂商、类型、版本和协议 */
export function normalizeModelId(model: string, entries: ModelCatalogEntry[] = BUILTIN_MODEL_CATALOG): NormalizedModel {
  const text = model.trim().toLowerCase()
  const bare = text.slice(text.lastIndexOf('/') + 1)
  const provider = text.includes('/') ? text.slice(0, text.lastIndexOf('/')).split('/')[0] : ''
  let rest = bare
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    // 日期和 :free 这类后缀不是版本
    .replace(/[-_]?(?:20\d{6}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/:[a-z0-9_-]+$/i, '')
  const protocols: ApiProtocol[] = []
  for (let changed = true; changed; ) {
    changed = false
    for (const [re, p] of PROTOCOL_SUFFIXES) {
      if (re.test(rest)) {
        rest = rest.replace(re, '')
        protocols.push(p)
        changed = true
        break
      }
    }
  }

  const tokens = rest.split(/[-_.\s]+/).filter(Boolean)
  const knownTypes = typeSetOf(entries)
  const firstVendor = vendorOf(tokens[0])
  let vendor = firstVendor ?? vendorOf(provider)
  const version: number[] = []
  const types = new Set<string>()
  const canonical: string[] = []
  let speed = false

  tokens.forEach((tok, i) => {
    // 第一个词可能带着版本：qwen3.8 → qwen3 + 8，gpt5 → gpt + 5
    if (i === 0) {
      const embedded = EMBEDDED_VENDOR.exec(tok)
      if (embedded && VENDORS[embedded[1]]) {
        vendor = VENDORS[embedded[1]]
        version.push(...numbers(embedded[2]))
        canonical.push(tok)
        return
      }
      if (/^o\d+$/.test(tok)) {
        vendor = 'openai'
        version.push(Number(tok.slice(1)))
        canonical.push(tok)
        return
      }
      // 只有第一个词本身就是厂商时才算厂商词；`anthropic/opus` 里的 opus 是类型
      if (firstVendor) {
        canonical.push(tok)
        return
      }
    }
    if (SPEED.has(tok)) {
      speed = true
      return
    }
    if (QUALIFIER.has(tok) || DATE.test(tok)) return
    const v = VERSION.exec(tok)
    if (v) {
      version.push(...numbers(v[1]))
      canonical.push(tok)
      return
    }
    const type = normalizeType(tok)
    if (knownTypes.has(type)) types.add(type)
    canonical.push(tok)
  })

  // 2.0 和 2 是同一个版本
  while (version.length > 1 && version[version.length - 1] === 0) version.pop()
  return {
    bare,
    canonical: canonical.join('-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''),
    vendor,
    version,
    types,
    protocols,
    speed,
  }
}

function versionScore(query: number[], entry: number[]) {
  if (query.length && entry.length) {
    if (query.length === entry.length && query.every((n, i) => n === entry[i])) return 120
    if (query[0] === entry[0]) return 60
    return -120
  }
  if (query.length) return -20
  if (entry.length) return 0
  return 20
}

function typeScore(query: Set<string>, entry: ModelCatalogEntry) {
  const type = normalizeType(entry.type)
  if (!query.size) return type === 'general' ? 30 : 0
  if (query.has(type)) return 1000
  // general 是没有类型时的兜底，不和具体的类型词冲突
  return type === 'general' ? -200 : -1000
}

export interface ModelMatch {
  entry: ModelCatalogEntry
  score: number
  tier: ModelTier
}

/**
 * 找这个模型对应的目录记录；找不到返回 undefined（调用方按 1M / 128K 估算）。
 * `protocol` 是当前 API 的协议，同分时优先选支持它的记录。
 */
export function matchModel(
  model: string,
  opts: { entries?: ModelCatalogEntry[]; protocol?: ApiProtocol } = {},
): ModelMatch | undefined {
  if (!model.trim()) return undefined
  const entries = opts.entries?.length ? opts.entries : BUILTIN_MODEL_CATALOG
  const query = normalizeModelId(model, entries)
  const normalized = new Map(entries.map((e) => [e, normalizeModelId(e.id, entries)]))

  let pool = entries
  if (query.vendor) {
    const sameVendor = entries.filter((e) => e.vendor.toLowerCase() === query.vendor)
    // 知道是哪个厂商，但目录里没有这个厂商的模型：不拿别家的凑数
    if (!sameVendor.length) return undefined
    pool = sameVendor
  } else {
    // 别名（opus / sonnet / haiku）没有厂商，只能按类型或完全相同的名字匹配
    const byType = entries.filter((e) => {
      const n = normalized.get(e)!
      return query.types.size > 0 && [...query.types].some((x) => n.types.has(x) || normalizeType(e.type) === x)
    })
    const byName = entries.filter((e) => {
      const n = normalized.get(e)!
      return [n.canonical, ...e.aliases.map((a) => normalizeModelId(a, entries).canonical)].includes(query.canonical)
    })
    const found = byType.length ? byType : byName
    if (!found.length) return undefined
    pool = found
  }

  const requested = opts.protocol ?? query.protocols[0]
  let best: { entry: ModelCatalogEntry; score: number } | undefined
  for (const entry of pool) {
    const n = normalized.get(entry)!
    const names = [n.canonical, ...entry.aliases.map((a) => normalizeModelId(a, entries).canonical)]
    const exact = names.includes(query.canonical) ? 200 : 0
    const protocol = requested ? (entry.protocols.length === 0 || entry.protocols.includes(requested) ? 40 : -40) : 0
    // 高、中、低档只用来在同分时打破平局，不影响类型和版本
    const tie = entry.tier === 'high' ? 0.3 : entry.tier === 'medium' ? 0.2 : 0.1
    const version = n.version.length ? n.version : parseVersion(entry.version)
    // 类型优先于版本，但不能拿旧模型去套新模型的数值：3.x 的 haiku 不能匹配 5.x 的 haiku
    const older = query.version.length > 0 && version.length > 0 && query.version[0] < version[0]
    const score =
      exact +
      typeScore(query.types, entry) +
      versionScore(query.version, version) +
      protocol +
      tie +
      (older ? -2000 : 0)
    if (!best || score > best.score) best = { entry, score }
  }
  // 分数太低说明只是名字里碰巧有某个词，不当作匹配
  return best && best.score >= 30 ? { entry: best.entry, score: best.score, tier: best.entry.tier } : undefined
}

/** 模型的上下文和最大输出；目录里没有时用 1M / 128K */
export function modelLimitsFor(
  model: string,
  opts: { entries?: ModelCatalogEntry[]; protocol?: ApiProtocol } = {},
): {
  context: number
  maxOutput: number
  efforts: string[]
  defaultEffort: string
  tier: ModelTier
  /** 能不能看图片；目录里没登记时为 undefined */
  images?: boolean
  entry?: ModelCatalogEntry
  matched: boolean
} {
  const hit = matchModel(model, opts)
  return hit
    ? {
        context: hit.entry.context,
        maxOutput: hit.entry.maxOutput,
        efforts: hit.entry.efforts,
        defaultEffort: hit.entry.defaultEffort,
        tier: hit.tier,
        images: hit.entry.images,
        entry: hit.entry,
        matched: true,
      }
    : {
        context: DEFAULT_MODEL_CONTEXT,
        maxOutput: DEFAULT_MODEL_MAX_OUTPUT,
        efforts: [],
        defaultEffort: '',
        tier: 'medium',
        matched: false,
      }
}

/** AI 补全的一次查询 */
export interface ModelLookupJob {
  id: string
  model: string
  protocol?: ApiProtocol
  status: 'running' | 'done' | 'failed'
  /** 模型输出的说明（JSON 前面的部分） */
  text: string
  entry?: ModelCatalogEntry
  error?: string
  startedAt: number
}

export interface ModelCatalogInfo {
  entries: ModelCatalogEntry[]
  /** 用户补充的目录文件 */
  file: string
  dir: string
  aiLookup: boolean
}
