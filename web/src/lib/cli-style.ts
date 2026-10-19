import { getCli, type CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
/** 每种 CLI 的标识色：写在 CLI 的定义里（配置文件的 color） */
export const cliColor = (id: string) => getCli(id)?.color ?? '#64748b'

/** 思考强度下拉框的选项；empty 是不指定时的说明 */
export const effortOptions = (def: CliDefinition, empty: string) => [
  { value: '', label: empty },
  ...def.efforts.map((e) => ({ value: e.id, label: `${e.id} · ${e.label}` })),
]
export const effortLabel = (def: CliDefinition | undefined, id: string) =>
  def?.efforts.find((e) => e.id === id)?.label ?? effortName(id)
/** 思考强度 id → 中文名：CLI 新出的强度没有中文名时直接用 id */
const EFFORT_NAMES: Record<string, string> = {
  off: t('不思考'),
  none: t('不思考'),
  minimal: t('最低'),
  low: t('低'),
  medium: t('中'),
  high: t('高'),
  xhigh: t('很高'),
  max: t('最高'),
  ultra: t('极限'),
}
export const effortName = (id: string) => EFFORT_NAMES[id] ?? id
/** 模型分两组：CLI 自己提供的（命令读到的或内置的），和配置文件里接的第三方 API */
export const modelGroup = (def: CliDefinition, m: { origin?: 'cli' | 'config' }) =>
  m.origin === 'config'
    ? CONFIG_GROUP()
    : def.id === 'claude' || def.spec
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
/** 这个模型支持的思考强度：CLI 报了这个模型的（读到的模型列表、安装包里的模型目录）就按它，不知道时按 CLI 的全部 */
export function modelEfforts(def: CliDefinition, model: string) {
  const m = def.models.find((x) => x.id === model)
  if (!m?.efforts) return def.efforts
  return m.efforts.map((id) => def.efforts.find((e) => e.id === id) ?? { id, label: effortName(id) })
}
/**
 * 「不指定」时用 CLI 默认的思考强度：不单独放默认选项，默认的那个值是 ''，后面标上（默认）；
 * 不知道 CLI 默认是哪个时才有一项「auto · 自动（默认）」。list 给某个模型的强度时只列这个模型支持的那些
 * （选了模型不认的强度时 CLI 会直接报错退出）。keep 是设置里存着的值：这个模型不支持时也列出来并标出来，
 * 不能只显示一个没有中文名的原始 id。
 */
export function defaultEffortOptions(def: CliDefinition, defaultId?: string, list = def.efforts, keep?: string) {
  const opts = list.map((e) => ({
    value: e.id === defaultId ? '' : e.id,
    label: e.id === defaultId ? t('{name}（默认）', { name: `${e.id} · ${e.label}` }) : `${e.id} · ${e.label}`,
  }))
  if (!defaultId || !list.some((e) => e.id === defaultId))
    opts.unshift({ value: '', label: defaultId ? t('{name}（默认）', { name: defaultId }) : t('auto · 自动（默认）') })
  if (keep && keep !== defaultId && !list.some((e) => e.id === keep))
    opts.push({
      value: keep,
      label: t('{name} · {label}（这个模型不支持）', { name: keep, label: effortName(keep) }),
    })
  return opts
}

/** CLI 输出的版本信息里只取版本号：Codex 输出「codex-cli 0.46.0」，Claude Code 输出「2.1.3 (Claude Code)」 */
export const shortVersion = (v?: string) => v?.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? v?.split(' ')[0] ?? ''
