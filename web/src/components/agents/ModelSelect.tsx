import { useState } from 'react'
import { MODEL_TIERS, type CliDefinition, type ModelTier } from '@shared/clis'
import { CONFIG_GROUP, modelGroup } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Input, Select } from '@/components/ui/input'
import { t } from '@shared/i18n'

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
  const apiMode = !!def.apiMode
  const opts: { value: string; label: string; group?: string }[] = [
    ...(o.tiers
      ? MODEL_TIERS.filter((m) => !apiMode || def.models.some((x) => x.id === o.tiers![m.id].model)).map((m) => ({
          value: `@${m.id}`,
          label: t('{tier}档 · {model}', { tier: m.label, model: o.tiers![m.id].model || t('自动') }),
          group: t('档位'),
        }))
      : []),
    ...def.models.map((m) => ({ value: m.id, label: m.id, group: modelGroup(def, m) })),
  ]
  // 组按固定顺序：档位、CLI 读取、配置文件
  opts.sort((a, b) => rank(a.group) - rank(b.group))
  // API 方式只列 API 里配的模型：以前存的、自己填的都不再放进「其他」组
  for (const v of [o.defaultValue, ...(o.extra ?? [])])
    if (v && !opts.some((x) => x.value === v) && !apiMode) opts.push({ value: v, label: v, group: t('其他') })
  const d = o.defaultValue
  return [
    ...(d ? [] : [{ value: '', label: t('自动（默认）') }]),
    ...opts.map((x) => (d && x.value === d ? { ...x, value: '', label: t('{name}（默认）', { name: x.label }) } : x)),
  ]
}
const rank = (g?: string) => (g === t('档位') ? 0 : g === CONFIG_GROUP() ? 2 : g === t('其他') ? 3 : 1)

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
  // 列表里没有的值（自己填的、以前存的）放进「其他」组里显示，不用切到输入框
  const options = modelOptions(def, { tiers, defaultValue, extra: value ? [value] : [] })
  // 只有主动选了「其他模型…」才显示输入框
  const [custom, setCustom] = useState(false)
  const shown = custom ? CUSTOM : value === defaultValue ? '' : value
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Select
        aria-label={ariaLabel ?? t('{cli} 模型', { cli: def.name })}
        value={shown}
        onChange={(e) => {
          const v = e.target.value
          setCustom(v === CUSTOM)
          if (v !== CUSTOM) onChange(v)
        }}
        options={[...options, ...(def.apiMode ? [] : [{ value: CUSTOM, label: t('其他模型…'), group: t('其他') }])]}
        className="font-mono text-[0.8125rem]"
      />
      {custom && (
        <Input
          autoFocus
          aria-label={t('模型名')}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder={t('填写完整的模型名')}
          className="h-9 font-mono text-[0.8125rem]"
          spellCheck={false}
        />
      )}
    </div>
  )
}
