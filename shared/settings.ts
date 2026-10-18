import { t } from './i18n.ts'
import { CLIS, getCli, MODEL_TIERS, type CliDefinition, type ModelTier } from './clis.ts'
import { CliSettings, Settings } from './schema.ts'
import { apiFits, apiInjection, type ApiConfig } from './accounts.ts'

export const defaultSettings = (): Settings => Settings.parse({})

/**
 * 档位留空时用的模型：设置了具体的默认模型就跟随它（改了默认模型，空着的档位跟着变），
 * 否则用内置的建议值。默认模型本身是档位时不算，免得互相引用。
 */
export function tierFallback(def: CliDefinition | undefined, defaultModel: string, t: ModelTier) {
  return (defaultModel && !defaultModel.startsWith('@') ? defaultModel : '') || def?.tiers[t].model || ''
}

/** 某个 CLI 的有效设置：没配置过的项用默认值补齐 */
export function cliSettings(
  settings: Settings,
  cliId: string,
): CliSettings & { command: string; permission: string; api?: ApiConfig } {
  const def = getCli(cliId)
  const s = CliSettings.parse(settings.clis[cliId] ?? {})
  // API 模式：选的 API 协议对得上时，把接口地址、密钥按 CLI 定义里的规则加进环境变量和参数（所有调用 CLI 的地方都经过这里）
  const api = s.authMode === 'api' ? settings.apis.find((a) => a.id === s.apiId) : undefined
  const inject = def?.auth && api && apiFits(def.auth, api) ? apiInjection(def.auth, api) : undefined
  const tier = (t: ModelTier) => ({
    model: s.tiers[t].model || tierFallback(def, s.defaultModel, t),
    effort: s.tiers[t].effort || def?.tiers[t].effort || '',
  })
  return {
    ...s,
    api: inject ? api : undefined,
    // CLI 定义自带的环境变量在最前，用户和 API 的覆盖它
    env: [...Object.entries(def?.env ?? {}).map(([key, value]) => ({ key, value })), ...s.env, ...(inject?.env ?? [])],
    extraArgs: inject ? [...s.extraArgs, ...inject.args] : s.extraArgs,
    command: s.command || def?.command || cliId,
    permission: s.permission || def?.defaultPermission || '',
    tiers: { high: tier('high'), medium: tier('medium'), low: tier('low') },
  }
}

/** 系统默认 CLI；设置里的值无效时用第一个 */
export const defaultCli = (settings: Settings) => (getCli(settings.defaultCli) ? settings.defaultCli : CLIS[0].id)

/** 按设置里的顺序排列 CLI；新加的、没排过的 CLI 按内置顺序跟在后面 */
export function orderClis<T extends { id: string }>(list: T[], order: string[]): T[] {
  const rank = (id: string) => {
    const i = order.indexOf(id)
    return i < 0 ? order.length + CLIS.findIndex((c) => c.id === id) : i
  }
  return [...list].sort((a, b) => rank(a.id) - rank(b.id))
}

export const tierToken = (t: ModelTier) => `@${t}`
/** 模型字段是档位时返回档位 */
export const tierOf = (model: string) => MODEL_TIERS.find((t) => model === `@${t.id}`)

/** CLI 支持这个思考强度吗；内置列表里没有的当作不支持 */
export const supportsEffort = (cli: string, effort: string) => !!getCli(cli)?.efforts.some((e) => e.id === effort)

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
  const model = t ? cs.tiers[t.id].model : pick
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
  const m = r.model || t('CLI 默认')
  return tier
    ? t('{tier}档 · {model}', { tier: tier.label, model: m })
    : a.model
      ? m
      : // 没选模型：直接写实际用的模型，CLI 名后面已经标了（默认），这里不再重复「默认」
        r.model || t('默认模型')
}
