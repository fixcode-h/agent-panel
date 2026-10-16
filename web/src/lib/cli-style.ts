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
  ...def.efforts.map((e) => ({ value: e.id, label: `${e.label} · ${e.id}` })),
]
export const effortLabel = (def: CliDefinition | undefined, id: string) =>
  def?.efforts.find((e) => e.id === id)?.label ?? id
