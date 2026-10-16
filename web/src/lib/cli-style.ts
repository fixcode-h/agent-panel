import type { CliDefinition } from '@shared/clis'
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
  m.origin === 'config' ? '配置文件 · 第三方 API' : def.id === 'claude' ? `${def.name} 内置` : `${def.name} 读取`
/** 模型建议的说明：CLI 自己的默认模型后面标上（默认） */
export const modelSuggestions = (def: CliDefinition | undefined) =>
  (def?.models ?? []).map((m) => ({
    value: m.id,
    label: `${m.label}${m.isDefault ? '（默认）' : ''}`,
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
    label: `${e.id} · ${e.label}${e.id === defaultId ? '（默认）' : ''}`,
  }))
  if (!defaultId || !def.efforts.some((e) => e.id === defaultId))
    opts.unshift({ value: '', label: defaultId ? `${defaultId}（默认）` : 'auto · 自动（默认）' })
  return opts
}
