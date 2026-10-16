import { useState } from 'react'
import { MODEL_TIERS, type CliDefinition, type ModelTier } from '@shared/clis'
import { modelGroup } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Input, Select } from '@/components/ui/input'

type Tiers = Record<ModelTier, { model: string; effort?: string }>
const CUSTOM = '__custom'

/**
 * 所有模型下拉共用的选项，分三组：三个档位、CLI 读到的模型、配置文件里接的第三方 API 模型。
 * 不单独放「默认」选项：留空时会用到的那一项直接标（默认），选它就是留空；
 * 不知道默认是哪个时（例如 Claude Code 按账号决定）才有一项「自动（默认）」。
 */
export function modelOptions(
  def: CliDefinition,
  o: { tiers?: Tiers; defaultValue?: string; extra?: string[] },
): { value: string; label: string; group?: string }[] {
  const opts: { value: string; label: string; group?: string }[] = [
    ...(o.tiers
      ? MODEL_TIERS.map((t) => ({
          value: `@${t.id}`,
          label: `${t.label}档 · ${o.tiers![t.id].model || '自动'}`,
          group: '档位',
        }))
      : []),
    ...def.models.map((m) => ({ value: m.id, label: m.id, group: modelGroup(def, m) })),
  ]
  // 组按固定顺序：档位、CLI 读取、配置文件
  opts.sort((a, b) => rank(a.group) - rank(b.group))
  for (const v of [o.defaultValue, ...(o.extra ?? [])])
    if (v && !opts.some((x) => x.value === v)) opts.push({ value: v, label: v, group: '其他' })
  const d = o.defaultValue
  return [
    ...(d ? [] : [{ value: '', label: '自动（默认）' }]),
    ...opts.map((x) => (d && x.value === d ? { ...x, value: '', label: `${x.label}（默认）` } : x)),
  ]
}
const rank = (g?: string) => (g === '档位' ? 0 : g?.startsWith('配置文件') ? 2 : g === '其他' ? 3 : 1)

/** 模型下拉；列表里没有的模型选「其他模型…」后自己填 */
export function ModelSelect({
  def,
  value,
  onChange,
  tiers,
  defaultValue,
  className,
  'aria-label': ariaLabel,
}: {
  def: CliDefinition
  value: string
  onChange: (v: string) => void
  /** 给出时在最上面列出三个档位（档位自己的模型下拉不列） */
  tiers?: Tiers
  /** 留空时实际会用的值（模型名或 @high 这样的档位） */
  defaultValue?: string
  className?: string
  'aria-label'?: string
}) {
  const options = modelOptions(def, { tiers, defaultValue })
  const listed = (v: string) => v === '' || v === defaultValue || options.some((o) => o.value === v)
  // 选了「其他模型…」，或者值不在列表里（列表读到之前也先按填写显示，读到后自动换回下拉）
  const [picked, setCustom] = useState(false)
  const custom = picked || !listed(value)
  const shown = custom ? CUSTOM : value === defaultValue ? '' : value
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Select
        aria-label={ariaLabel ?? `${def.name} 模型`}
        value={shown}
        onChange={(e) => {
          const v = e.target.value
          setCustom(v === CUSTOM)
          if (v !== CUSTOM) onChange(v)
        }}
        options={[...options, { value: CUSTOM, label: '其他模型…', group: '其他' }]}
        className="font-mono text-[13px]"
      />
      {custom && (
        <Input
          autoFocus={!value}
          aria-label="模型名"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="填写完整的模型名"
          className="h-9 font-mono text-[13px]"
          spellCheck={false}
        />
      )}
    </div>
  )
}
