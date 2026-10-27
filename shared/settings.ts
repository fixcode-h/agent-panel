import { t } from './i18n.ts'
import { CLIS, getCli, MODEL_TIERS, type CliDefinition, type ModelTier } from './clis.ts'
import { AUTO_COMPACT_DEFAULT, CliSettings, SETTINGS_DEFAULTS_VERSION, Settings } from './schema.ts'
import {
  apiFits,
  apiInjection,
  apiModelIdFor,
  apiModelPrefix,
  modelForProtocol,
  modelsForProtocol,
  type ApiConfig,
} from './accounts.ts'

export const defaultSettings = (): Settings => Settings.parse({})

/**
 * 老设置里各项默认值的迁移：正式后端（`server/settings.ts` 的 `getSettings`）和演示后端（`web/src/lib/demo-backend.ts`）
 * 共用这一份，返回是否有改动（调用方据此决定要不要写回）。只在读设置时做，幂等
 */
export function migrateSettingsDefaults(s: Settings): boolean {
  let dirty = false
  // 后台命令的并发默认值从 16 提到 64：存着的正好是旧默认值就升级，显式设过其他值的保持不动
  if (s.backgroundLimit === 16) {
    s.backgroundLimit = 64
    dirty = true
  }
  // 自动压缩的默认值从「按 Agent 自己的规则」（0）改成 70%：0 是界面上也有的选项，不能按值判断，
  // 只对没升过版本的设置迁一次；升过版本之后用户显式选回 0 不会被反复改掉
  if (s.defaultsVersion < SETTINGS_DEFAULTS_VERSION) {
    for (const c of Object.values(s.clis)) if (c.autoCompact === 0) c.autoCompact = AUTO_COMPACT_DEFAULT
    s.defaultsVersion = SETTINGS_DEFAULTS_VERSION
    dirty = true
  }
  return dirty
}

/**
 * 档位留空时用的模型：设置了具体的默认模型就跟随它（改了默认模型，空着的档位跟着变），
 * 否则用内置的建议值。默认模型本身是档位时不算，免得互相引用。
 */
export function tierFallback(def: CliDefinition | undefined, defaultModel: string, t: ModelTier) {
  return (defaultModel && !defaultModel.startsWith('@') ? defaultModel : '') || def?.tiers[t].model || ''
}

/**
 * 账号方式下实际用的模型：切回账号后，旧 API 方式留下的 provider 前缀和协议后缀不是账号模型 ID，
 * 执行时会被 CLI 判为 unknown model，去掉。设置页的下拉也按这个显示，和实际执行的一致。
 */
export function accountModelId(def: CliDefinition | undefined, api: ApiConfig | undefined, model: string) {
  if (!def?.auth || !api) return model
  const prefix = apiModelPrefix(def.auth, api)
  const native = prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model
  const suffixes = {
    anthropic: ['-anthropic-messages', '-anthropic'],
    'openai-responses': ['-responses'],
    'openai-chat': ['-chat', '-completions'],
    gemini: ['-gemini'],
  }[api.protocol]
  const suffix = suffixes?.find((x) => native.endsWith(x))
  return suffix ? native.slice(0, -suffix.length) : native
}

/** 某个 CLI 的有效设置：没配置过的项用默认值补齐 */
export function cliSettings(
  settings: Settings,
  cliId: string,
): CliSettings & { command: string; permission: string; api?: ApiConfig } {
  const def = getCli(cliId)
  const s = CliSettings.parse(settings.clis[cliId] ?? {})
  const selectedApi = settings.apis.find((a) => a.id === s.apiId)
  // API 模式：选的 API 协议对得上时，把接口地址、密钥按 CLI 定义里的规则加进环境变量和参数（所有调用 CLI 的地方都经过这里）
  const api = s.authMode === 'api' ? selectedApi : undefined
  const inject = def?.auth && api && apiFits(def.auth, api) ? apiInjection(def.auth, api) : undefined
  const accountModel = (model: string) => (s.authMode === 'account' ? accountModelId(def, selectedApi, model) : model)
  const tier = (t: ModelTier) => ({
    model: accountModel(s.tiers[t].model || tierFallback(def, s.defaultModel, t)),
    effort: s.tiers[t].effort || def?.tiers[t].effort || '',
    // 0 是自动：不传给 CLI，面板估算时按模型的默认值
    context: s.tiers[t].context,
    maxOutput: s.tiers[t].maxOutput,
  })
  // 定义里的开关：没改过的用默认值；开着的把它的环境变量加上
  const options = Object.fromEntries((def?.options ?? []).map((o) => [o.id, s.options[o.id] ?? o.default]))
  const optionEnv = (def?.options ?? []).filter((o) => options[o.id]).flatMap((o) => Object.entries(o.env))
  return {
    ...s,
    defaultModel: accountModel(s.defaultModel),
    options,
    api: inject ? api : undefined,
    // CLI 定义自带的环境变量在最前，开关的其次，用户和 API 的覆盖它们
    env: [
      ...[...Object.entries(def?.env ?? {}), ...optionEnv].map(([key, value]) => ({ key, value })),
      ...s.env,
      ...(inject?.env ?? []),
    ],
    extraArgs: inject ? [...s.extraArgs, ...inject.args] : s.extraArgs,
    command: s.command || def?.command || cliId,
    permission: s.permission || def?.defaultPermission || '',
    tiers: { high: tier('high'), medium: tier('medium'), low: tier('low') },
  }
}

/**
 * 系统默认 CLI；设置里的值无效时用第一个。
 * 选的那个被停用了就换成按顺序第一个启用的，免得 Agent 一直落到停用的 CLI 上；一个都没启用时照旧返回设置里的值
 */
export function defaultCli(settings: Settings) {
  const set = getCli(settings.defaultCli) ? settings.defaultCli : CLIS[0].id
  if (cliSettings(settings, set).enabled) return set
  return (
    orderClis(CLIS, settings.cliOrder, (c) => cliSettings(settings, c.id).enabled).find(
      (c) => cliSettings(settings, c.id).enabled,
    )?.id ?? set
  )
}

/**
 * 按激活状态和拖动顺序排列 CLI：启用的排在停用的前面，拖动也不能跨过这条线；
 * 同一组里按拖动过的顺序，没拖过的按名字比较。
 */
export function orderClis<T extends { id: string; name?: string }>(
  list: T[],
  order: string[],
  isEnabled: (item: T) => boolean = () => true,
): T[] {
  const rank = (id: string) => {
    const i = order.indexOf(id)
    return i < 0 ? Number.POSITIVE_INFINITY : i
  }
  const name = (x: T) => x.name ?? getCli(x.id)?.name ?? x.id
  return [...list].sort((a, b) => {
    const group = Number(!isEnabled(a)) - Number(!isEnabled(b))
    if (group) return group
    const ra = rank(a.id)
    const rb = rank(b.id)
    if (ra !== rb) return ra < rb ? -1 : 1
    return name(a).localeCompare(name(b))
  })
}

export const tierToken = (t: ModelTier) => `@${t}`
/** 模型字段是档位时返回档位 */
export const tierOf = (model: string) => MODEL_TIERS.find((t) => model === `@${t.id}`)

/**
 * 模型不支持某个思考强度时换成最接近的那档：按 CLI 的档位顺序先往高找，再往低找（Pi 自己也是这样夹的）。
 * order 是 CLI 的全部档位，list 是这个模型支持的；want 为空或模型一档都不支持时返回空
 */
export function clampEffort(order: string[], list: string[], want?: string) {
  if (!want || !list.length) return ''
  if (list.includes(want)) return want
  const at = order.indexOf(want)
  if (at < 0) return ''
  for (let i = at + 1; i < order.length; i++) if (list.includes(order[i])) return order[i]
  for (let i = at - 1; i >= 0; i--) if (list.includes(order[i])) return order[i]
  return ''
}

/** CLI 支持这个思考强度吗；模型驱动的 CLI 交给执行前按模型判断，这里先放行 */
export const supportsEffort = (cli: string, effort: string) => {
  const def = getCli(cli)
  return !!def && (def.effortsFromModel || def.efforts.some((e) => e.id === effort))
}

/** Agent 实际使用的 CLI：没选时用系统默认 */
export const agentCli = (a: { cli: string }, settings: Settings) => a.cli || defaultCli(settings)

/**
 * Agent 实际传给 CLI 的模型和思考强度：
 * 模型为空时用 CLI 的默认模型（也可以是档位）；档位换成设置里对应的模型；
 * 思考强度依次取 Agent 自己的、档位的、CLI 默认的。
 */
export function agentRun(a: { cli: string; model: string; effort?: string }, settings: Settings) {
  const cli = agentCli(a, settings)
  const cs = cliSettings(settings, cli)
  const pick = a.model || cs.defaultModel
  const t = tierOf(pick)
  let model = t ? cs.tiers[t.id].model : pick
  // API 方式只认 API 里配的模型：别的协议后缀换成当前协议的，找不到就换成第一个可用模型
  if (cs.api?.models.length) {
    const auth = getCli(cli)?.auth
    const prefix = apiModelPrefix(auth, cs.api)
    const native = prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model
    const allowed = modelsForProtocol(cs.api.models, cs.api.protocol)
    model = apiModelIdFor(modelForProtocol(native, cs.api.protocol, allowed), auth, cs.api)
  }
  // Agent 自己选的思考强度换了 CLI 后可能不支持（例如跟随默认 CLI 换成了 Command Code），这时用档位的
  const own = a.effort && supportsEffort(cli, a.effort) ? a.effort : ''
  const effort = own || (t ? cs.tiers[t.id].effort : '') || cs.defaultEffort
  return { cli, model, effort, tier: t }
}

/** Agent 实际用的权限：自己指定且这个 CLI 支持就用自己的，否则跟随 CLI 设置（换过 CLI 时旧值可能不认） */
export function agentPermission(a: { cli: string; permission?: string }, settings: Settings) {
  const cli = agentCli(a, settings)
  const ok = a.permission && getCli(cli)?.permissions.some((p) => p.id === a.permission)
  return ok ? a.permission! : cliSettings(settings, cli).permission
}

export const agentModel = (a: { cli: string; model: string }, settings: Settings) => agentRun(a, settings).model

/** 列表里显示的模型：「中档 · sonnet」「opus」「默认 · sonnet」 */
export function modelText(a: { cli: string; model: string; effort?: string }, settings: Settings) {
  const r = agentRun(a, settings)
  const tier = tierOf(a.model)
  const m = r.model || t('Agent 默认')
  return tier
    ? t('{tier}档 · {model}', { tier: tier.label, model: m })
    : a.model
      ? m
      : // 没选模型：直接写实际用的模型，CLI 名后面已经标了（默认），这里不再重复「默认」
        r.model || t('默认模型')
}
