import { CLIS, getCli, MODEL_TIERS, type ModelTier } from './clis.ts'
import { CliSettings, Settings } from './schema.ts'

export const defaultSettings = (): Settings => Settings.parse({})

/** 某个 CLI 的有效设置：没配置过的项用默认值补齐 */
export function cliSettings(settings: Settings, cliId: string): CliSettings & { command: string; permission: string } {
  const def = getCli(cliId)
  const s = CliSettings.parse(settings.clis[cliId] ?? {})
  return {
    ...s,
    command: s.command || def?.command || cliId,
    permission: s.permission || def?.defaultPermission || '',
    tiers: {
      high: s.tiers.high || def?.tiers.high || '',
      medium: s.tiers.medium || def?.tiers.medium || '',
      low: s.tiers.low || def?.tiers.low || '',
    },
  }
}

/** 系统默认 CLI；设置里的值无效时用第一个 */
export const defaultCli = (settings: Settings) => (getCli(settings.defaultCli) ? settings.defaultCli : CLIS[0].id)

export const tierToken = (t: ModelTier) => `@${t}`
/** 模型字段是档位时返回档位 */
export const tierOf = (model: string) => MODEL_TIERS.find((t) => model === `@${t.id}`)

/** Agent 实际使用的 CLI：没选时用系统默认 */
export const agentCli = (a: { cli: string }, settings: Settings) => a.cli || defaultCli(settings)

/** Agent 实际传给 CLI 的模型：档位换成对应模型，为空用 CLI 的默认模型（仍为空则不传） */
export function agentModel(a: { cli: string; model: string }, settings: Settings) {
  const cs = cliSettings(settings, agentCli(a, settings))
  const t = tierOf(a.model)
  return t ? cs.tiers[t.id] : a.model || cs.defaultModel
}

/** 列表里显示的模型：「中档 · sonnet」「opus」「默认模型」 */
export function modelText(a: { cli: string; model: string }, settings: Settings) {
  const t = tierOf(a.model)
  const m = agentModel(a, settings)
  return t ? `${t.label}档${m ? ` · ${m}` : ''}` : a.model || (m ? `默认 · ${m}` : '默认模型')
}
