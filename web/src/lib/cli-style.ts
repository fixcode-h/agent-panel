import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
/** 每种 CLI 的标识色；新增 CLI 时补一项即可，缺省走 fallback */
const colors: Record<string, string> = {
  claude: '#c96442',
  codex: '#0e8a6b',
  commandcode: '#b4307a',
}

export const cliColor = (id: string) => colors[id] ?? '#64748b'

/** 思考强度下拉框的选项；empty 是不指定时的说明 */
export const effortOptions = (def: CliDefinition, empty: string) => [
  { value: '', label: empty },
  ...def.efforts.map((e) => ({ value: e.id, label: `${e.id} · ${e.label}` })),
]
export const effortLabel = (def: CliDefinition | undefined, id: string) =>
  def?.efforts.find((e) => e.id === id)?.label ?? id
/** 模型分两组：CLI 自己提供的（命令读到的或内置的），和配置文件里接的第三方 API */
export const modelGroup = (def: CliDefinition, m: { origin?: 'cli' | 'config' }) =>
  m.origin === 'config'
    ? CONFIG_GROUP()
    : def.id === 'claude'
      ? t('{cli} 内置', { cli: def.name })
      : t('{cli} 读取', { cli: def.name })
/** 配置文件里第三方 API 模型的组名；排序时按它认组，不按中文前缀 */
export const CONFIG_GROUP = () => t('配置文件 · 第三方 API')
/** 模型建议的说明：CLI 自己的默认模型后面标上（默认） */
export const modelSuggestions = (def: CliDefinition | undefined) =>
  (def?.models ?? []).map((m) => ({
    value: m.id,
    label: m.isDefault ? t('{name}（默认）', { name: m.label }) : m.label,
    group: modelGroup(def!, m),
  }))
/** CLI 自己的默认模型和它的默认思考强度 */
export const cliDefaultModel = (def: CliDefinition) => def.models.find((m) => m.isDefault)
/**
 * 「不指定」时用 CLI 默认的思考强度：不单独放默认选项，默认的那个值是 ''，后面标上（默认）；
 * 不知道 CLI 默认是哪个时才有一项「auto · 自动（默认）」。
 */
export function defaultEffortOptions(def: CliDefinition, defaultId?: string) {
  const opts = def.efforts.map((e) => ({
    value: e.id === defaultId ? '' : e.id,
    label: e.id === defaultId ? t('{name}（默认）', { name: `${e.id} · ${e.label}` }) : `${e.id} · ${e.label}`,
  }))
  if (!defaultId || !def.efforts.some((e) => e.id === defaultId))
    opts.unshift({ value: '', label: defaultId ? t('{name}（默认）', { name: defaultId }) : t('auto · 自动（默认）') })
  return opts
}

/** CLI 输出的版本信息里只取版本号：Codex 输出「codex-cli 0.46.0」，Claude Code 输出「2.1.3 (Claude Code)」 */
export const shortVersion = (v?: string) => v?.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? v?.split(' ')[0] ?? ''
