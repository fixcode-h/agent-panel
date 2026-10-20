import { z } from 'zod'

/**
 * 账号和 API：每个 CLI 可以用「账号」（浏览器登录的订阅账号）或「API」（全局设置里配的接口 + 密钥）。
 * 这里是前后端共用的结构，和怎么把 API 交给各个 CLI 的规则（写在 CLI 的定义里，见 shared/clis.ts）。
 */

/** API 的协议：决定哪些 CLI 能用它 */
export const API_PROTOCOLS = ['anthropic', 'openai-responses', 'openai-chat', 'gemini'] as const
export type ApiProtocol = (typeof API_PROTOCOLS)[number]

export const API_PROTOCOL_LABEL: Record<ApiProtocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat Completions',
  gemini: 'Gemini',
}

/** 从展示名生成 CLI 配置里的 provider 名；只保留 ASCII 标识符字符 */
export function providerSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** 全局设置里的一个 API：接口地址、密钥和可用的模型 */
export const ApiConfig = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  /**
   * 写进 CLI 配置的 provider 名。识别到的 API 用配置文件里的键（如 tokenapi），
   * 新建的留空时从 name 生成，避免把展示名直接当成机器标识。
   */
  provider: z
    .string()
    .trim()
    .max(60)
    .regex(/^[A-Za-z0-9_-]*$/)
    .default(''),
  protocol: z.enum(API_PROTOCOLS).default('openai-chat'),
  baseUrl: z.string().trim().default(''),
  apiKey: z.string().default(''),
  /** Anthropic 协议：密钥用哪种方式带（x-api-key，或 Authorization: Bearer） */
  authHeader: z.enum(['x-api-key', 'bearer']).default('x-api-key'),
  /** 这个 API 可用的模型（可以从接口读取，也可以自己填）；第一个是默认 */
  models: z.array(z.string().trim().min(1)).default([]),
  /**
   * 模型映射：模型名 → 模型目录里的另一个模型。自动识别不准时，上下文和最大输出按映射到的配置算；
   * 发给 CLI 的仍然是原来的模型名
   */
  modelMap: z.record(z.string(), z.string()).default({}),
  /** 每个模型的默认思考强度：模型名 → 强度 id；没有时用模型目录里的默认值 */
  modelEfforts: z.record(z.string(), z.string()).default({}),
})
export type ApiConfig = z.infer<typeof ApiConfig>

/** CLI 配置里的 provider 名：显式值优先，否则从 API 名称生成 */
export function apiProvider(api: Pick<ApiConfig, 'name' | 'provider'>, fallback = 'agentpanel') {
  return (api.provider.trim() || providerSlug(api.name) || fallback).slice(0, 60)
}

/** 改配置文件里的一些键（JSON / TOML / .env）：set 的键可以写成 a.b.c；占位见 fillTemplate */
export const JsonEdit = z.object({
  file: z.string().min(1),
  /** 配置文件格式：JSON、TOML（Codex）或 .env（Gemini） */
  format: z.enum(['json', 'toml', 'env']).default('json'),
  set: z.record(z.string(), z.unknown()).default({}),
  /** 浅合并还是直接替换；合并时对象递归合并，数组仍然替换 */
  merge: z.boolean().default(false),
  unset: z.array(z.string()).default([]),
})
export type JsonEdit = z.infer<typeof JsonEdit>

/**
 * CLI 自己的配置里 API 写在哪：识别出来后可以存进全局的 API 列表给别的 CLI 用。
 * 每一项的键名按顺序取第一个有值的；值写成 $NAME / ${NAME}，或者正好是一个存在的环境变量名时，取那个环境变量
 */
export const ApiSource = z.object({
  /** 配置文件（~ 是用户目录，${ENV:-默认值} 先取环境变量）；不写表示看环境变量（系统的加上这个 CLI 设置里的） */
  file: z.string().default(''),
  format: z.enum(['json', 'toml', 'env']).default('json'),
  /** 配置所在的键（a.b）；不写是整个文件 */
  at: z.string().default(''),
  /** at 下面每个子键各是一个 API（例如 Codex 的 model_providers.<名字>） */
  each: z.boolean().default(false),
  /** 读不到协议写法时用的协议 */
  protocol: z.enum(API_PROTOCOLS),
  /** 协议写法 → 协议；不写时用 api.wire 反查 */
  wire: z.record(z.string(), z.enum(API_PROTOCOLS)).default({}),
  /** 接口地址的键；都没有值时用 defaultBaseUrl */
  baseUrl: z.array(z.string()).default([]),
  defaultBaseUrl: z.string().default(''),
  /** 密钥的键；bearerKey 里的是用 Authorization: Bearer 发的（Anthropic 的 ANTHROPIC_AUTH_TOKEN） */
  apiKey: z.array(z.string()).default([]),
  bearerKey: z.array(z.string()).default([]),
  /** 值是环境变量名的键（例如 Codex 的 env_key） */
  keyEnv: z.array(z.string()).default([]),
  /** 模型的键：字符串、字符串数组、[{ id }] 或以模型名为键的对象都认 */
  models: z.array(z.string()).default([]),
  /** 协议写法的键 */
  wireKey: z.array(z.string()).default([]),
  /** 名字的键；不写时用子键名 */
  name: z.array(z.string()).default([]),
})
export type ApiSource = z.infer<typeof ApiSource>

/** 识别到的一个 API：来自哪个 CLI 的哪个配置 */
export interface DetectedApi {
  cli: string
  /** 配置文件路径，或「环境变量」 */
  source: string
  api: ApiConfig
}

/** 接口地址的比较键：忽略末尾的 / 和常见的 /v1、/v1beta 后缀 */
const apiBase = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1(?:beta)?$/i, '')

/** 两个 API 是不是同一个：接口地址和密钥一样；协议只是使用方式，不参与判断 */
export const sameApi = (a: Pick<ApiConfig, 'baseUrl' | 'apiKey'>, b: typeof a) =>
  apiBase(a.baseUrl) === apiBase(b.baseUrl) && a.apiKey === b.apiKey

/**
 * 把模型条目里的思考强度改成 effortsFor 返回的列表；返回有没有改动。
 * effortsFor 返回 undefined 的模型保持原样（目录里不认识的模型不动用户配置）。
 */
export function setModelEfforts(
  data: unknown,
  at: string,
  key: string,
  effortsFor: (model: string) => string[] | undefined,
): boolean {
  let models: unknown = data
  for (const part of at.split('.')) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) return false
    models = (models as Record<string, unknown>)[part]
  }
  if (!models || typeof models !== 'object' || Array.isArray(models)) return false
  let changed = false
  for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const model = typeof rec.id === 'string' && rec.id ? rec.id : id
    const efforts = effortsFor(model)
    if (!efforts || JSON.stringify(rec[key]) === JSON.stringify(efforts)) continue
    rec[key] = efforts
    changed = true
  }
  return changed
}

/** CLI 怎么用账号登录、凭据存在哪、怎么改用 API */
export const CliAuth = z.object({
  /** 账号登录页上的提醒（例如这个 CLI 对账号类型有限制） */
  accountNote: z.string().default(''),
  /** 登录的命令行参数（会打开浏览器）；不写表示这个 CLI 不能在面板里登录 */
  login: z.array(z.string()).default([]),
  /** 登录时从 stdin 写进去的内容（例如要确认的 y） */
  loginStdin: z.string().default(''),
  /** 登录前先改的配置（例如 Gemini CLI 要先选登录方式） */
  loginEdits: z.array(JsonEdit).default([]),
  /** 凭据所在的目录：~ 是用户目录，${ENV:-默认值} 先取环境变量 */
  home: z.string().min(1),
  /** 凭据文件（相对 home）：保存账号就是把它们存起来，切换账号就是写回去 */
  files: z.array(z.string()).default([]),
  /** 其他 JSON 文件里属于账号的键（例如 Claude Code 在 .claude.json 里记着账号信息） */
  fields: z.array(z.object({ file: z.string(), keys: z.array(z.string()) })).default([]),
  /** macOS 钥匙串里的条目名（Claude Code 在 macOS 上把凭据放在钥匙串） */
  keychain: z.string().default(''),
  /** 从凭据里认出是哪个账号（邮箱）的方式；none 表示认不出，用保存时起的名字 */
  identity: z.enum(['claude', 'codex', 'gemini', 'none']).default('none'),
  /** 改用 API 时怎么交给 CLI */
  api: z
    .object({
      /** 能用哪些协议的 API */
      protocols: z.array(z.enum(API_PROTOCOLS)).min(1),
      /** API 没有指定 provider 时用这个名字写进 CLI 配置 */
      defaultProvider: z.string().default('agentpanel'),
      /**
       * API 模式下模型从哪里来：cli 从 CLI 自己的配置/列表读（API 会先写进 CLI 配置）；
       * api 直接用全局 API 里配的模型（例如只通过环境变量接收配置的 CLI）
       */
      modelSource: z.enum(['cli', 'api']).default('api'),
      /** 模型 ID 的前缀模板，例如 "{provider}/"；配置里写模型时会把同样的前缀去掉 */
      modelPrefix: z.string().default(''),
      /** 加的环境变量；值为空的不加 */
      env: z.record(z.string(), z.string()).default({}),
      /** 加的命令行参数 */
      args: z.array(z.string()).default([]),
      /** 改用 API 时要改的配置文件 */
      edits: z.array(JsonEdit).default([]),
      /** 改回账号时要还原的配置文件 */
      accountEdits: z.array(JsonEdit).default([]),
      /** 协议在这个 CLI 配置里的写法，用 {wire} 引用 */
      wire: z.record(z.string(), z.string()).default({}),
      /**
       * CLI 只认配置里模型条目自己声明的思考强度时（例如 Command Code 的 providers.json），
       * 把模型目录里的强度写回这个位置；不写表示不处理。
       */
      modelEfforts: z
        .object({
          file: z.string(),
          /** 模型条目所在的位置，例如 provider.{provider}.models */
          at: z.string(),
          /** 写进模型条目的键名 */
          key: z.string().default('reasoningEfforts'),
        })
        .optional(),
    })
    .optional(),
  /** CLI 自己配置的 API 写在哪，用来识别 */
  apiSources: z.array(ApiSource).default([]),
})
export type CliAuth = z.infer<typeof CliAuth>

/**
 * 填占位：{baseUrl}、{apiKey}、{name}、{id}、{protocol}、{wire}、{keyEnv}（Anthropic 协议按 authHeader 选 ANTHROPIC_API_KEY 或
 * ANTHROPIC_AUTH_TOKEN）；{x|json} 填成 JSON 字符串（带引号，写进 TOML 参数时用）。
 * 整个值正好是 {models} 时换成 { 模型: {} } 的对象，正好是 {modelList} 时换成 [{ id: 模型 }] 的数组（Pi 的 models.json）
 */
export function apiVars(api: ApiConfig, wire: Record<string, string> = {}, provider = apiProvider(api)) {
  return {
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    name: api.name,
    id: api.id,
    provider,
    protocol: api.protocol,
    wire: wire[api.protocol] ?? api.protocol,
    keyEnv: api.authHeader === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY',
  } as Record<string, string>
}

export function fillTemplate(s: string, vars: Record<string, string>) {
  return s.replace(/\{(\w+)(\|json)?\}/g, (m, k: string, json?: string) =>
    k in vars ? (json ? JSON.stringify(vars[k]) : vars[k]) : m,
  )
}

/** 写进 provider 配置时去掉模型 ID 上重复的 provider 前缀 */
export function nativeModelId(model: string, prefix: string) {
  return prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model
}

/** 显示和传给 CLI 的完整模型 ID：没有前缀的补上，已有的不重复 */
export function apiModelList(api: ApiConfig, prefix: string) {
  return api.models.map((m) => (prefix && !m.startsWith(prefix) ? prefix + m : m))
}

/** 这个 CLI 在 API 模式下给模型加的前缀，例如 codeg/ */
export function apiModelPrefix(auth: CliAuth | undefined, api: ApiConfig) {
  const spec = auth?.api
  if (!spec?.modelPrefix) return ''
  return fillTemplate(spec.modelPrefix, apiVars(api, spec.wire, apiProvider(api, spec.defaultProvider)))
}

/**
 * 执行时把旧的、没带 provider 前缀的模型 ID 补上当前 API 的前缀。
 * 已经带前缀的、档位（@high）和不在这个 API 模型列表里的值保持原样。
 */
export function apiModelIdFor(model: string, auth: CliAuth | undefined, api: ApiConfig | undefined) {
  if (!api || !model || model.startsWith('@')) return model
  const prefix = apiModelPrefix(auth, api)
  if (!prefix || model.startsWith(prefix)) return model
  const native = api.models.map((m) => nativeModelId(m, prefix))
  return !native.length || native.includes(model) ? prefix + model : model
}

function fillValue(v: unknown, vars: Record<string, string>, api: ApiConfig, prefix: string): unknown {
  if (typeof v === 'string')
    return v === '{models}'
      ? Object.fromEntries(api.models.map((m) => [nativeModelId(m, prefix), {}]))
      : v === '{modelList}'
        ? api.models.map((m) => ({ id: nativeModelId(m, prefix) }))
        : fillTemplate(v, vars)
  if (Array.isArray(v)) return v.map((x) => fillValue(x, vars, api, prefix))
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [fillTemplate(k, vars), fillValue(x, vars, api, prefix)]),
    )
  return v
}

/** 这个 CLI 能不能用这个 API（协议对得上） */
export const apiFits = (auth: CliAuth | undefined, api: ApiConfig | undefined) =>
  !!auth?.api && !!api && auth.api.protocols.includes(api.protocol)

/** 填一份配置编辑；没有 API（切回账号）时仍可用最后选用的 API 填 {provider} */
export function fillEdits(edits: JsonEdit[], auth: CliAuth, api?: ApiConfig, lastProvider?: string): JsonEdit[] {
  const spec = auth.api!
  const provider = api ? apiProvider(api, spec.defaultProvider) : lastProvider?.trim() || spec.defaultProvider
  const base: ApiConfig = api ?? {
    id: '',
    name: '',
    provider,
    protocol: 'openai-chat',
    baseUrl: '',
    apiKey: '',
    authHeader: 'x-api-key',
    models: [],
    modelMap: {},
    modelEfforts: {},
  }
  const vars = apiVars(base, spec.wire, provider)
  const prefix = api && spec.modelPrefix ? fillTemplate(spec.modelPrefix, vars) : ''
  return edits.map((e) => ({
    file: fillTemplate(e.file, vars),
    format: e.format,
    merge: e.merge,
    set: fillValue(e.set, vars, base, prefix) as Record<string, unknown>,
    unset: e.unset.map((u) => fillTemplate(u, vars)),
  }))
}

/** 用 API 时要加给 CLI 的环境变量、参数和要改的配置文件 */
export function apiInjection(auth: CliAuth, api: ApiConfig) {
  const spec = auth.api!
  const provider = apiProvider(api, spec.defaultProvider)
  const vars = apiVars(api, spec.wire, provider)
  const prefix = spec.modelPrefix ? fillTemplate(spec.modelPrefix, vars) : ''
  return {
    provider,
    modelPrefix: prefix,
    env: Object.entries(spec.env)
      .map(([k, v]) => ({ key: fillTemplate(k, vars), value: fillTemplate(v, vars) }))
      .filter((e) => e.key && e.value),
    args: spec.args.map((a) => fillTemplate(a, vars)),
    edits: spec.edits.map((e) => ({
      file: fillTemplate(e.file, vars),
      format: e.format,
      merge: e.merge,
      set: fillValue(e.set, vars, api, prefix) as Record<string, unknown>,
      unset: e.unset.map((u) => fillTemplate(u, vars)),
    })),
  }
}
