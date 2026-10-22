import { getCli, type CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import { clampEffort } from '@shared/settings'
/** 每种 CLI 的标识色：写在 CLI 的定义里（配置文件的 color） */
export const cliColor = (id: string) => getCli(id)?.color ?? '#64748b'

/** 模型分两组：CLI 自己提供的（命令读到的或内置的），和配置文件里接的第三方 API */
export const modelGroup = (def: CliDefinition, m: { origin?: 'cli' | 'config' }) =>
  m.origin === 'config'
    ? CONFIG_GROUP()
    : // cli-id-ok: Claude Code 没有列模型的命令，模型是面板内置的；以后有字段表达「模型来源」时换掉
      def.id === 'claude' || def.spec
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
  return m.efforts.map((id) => ({ id }))
}
/**
 * 思考强度的选项：只显示 CLI 的英文取值（off / low / high / max），不追加中文名。
 * 「不指定」时用 CLI 默认的强度，那个选项的值是 ''；不知道默认是哪个时标成 auto。
 * list 给某个模型的强度时只列这个模型支持的那些（模型不认的强度 CLI 会直接报错退出）；
 * 默认强度这个模型不支持时换成最接近的那档，不把不支持的档位放进下拉
 */
export function defaultEffortOptions(def: CliDefinition, defaultId?: string, list: { id: string }[] = def.efforts) {
  const shown = defaultShown(def, defaultId, list)
  const opts = list.map((e) => ({ value: e.id === shown ? '' : e.id, label: e.id }))
  if (!shown) opts.unshift({ value: '', label: defaultId || 'auto' })
  return opts
}

const defaultShown = (def: CliDefinition, defaultId: string | undefined, list: { id: string }[]) =>
  list.length
    ? clampEffort(
        def.efforts.map((e) => e.id),
        list.map((e) => e.id),
        defaultId,
      )
    : (defaultId ?? '')

/**
 * 下拉里显示的值：存着的强度这个模型不支持时显示实际会用的那档（执行时同样换成最接近的），
 * 和默认一样时是 ''
 */
export function effortValue(def: CliDefinition, defaultId: string | undefined, list: { id: string }[], value: string) {
  const v = list.length
    ? clampEffort(
        def.efforts.map((e) => e.id),
        list.map((e) => e.id),
        value,
      )
    : value
  return !v || v === defaultShown(def, defaultId, list) ? '' : v
}

/** CLI 输出的版本信息里只取版本号：Codex 输出「codex-cli 0.46.0」，Claude Code 输出「2.1.3 (Claude Code)」 */
export const shortVersion = (v?: string) => v?.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? v?.split(' ')[0] ?? ''
