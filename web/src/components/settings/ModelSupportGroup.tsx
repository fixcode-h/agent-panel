import { useEffect, useState } from 'react'
import type { ModelTier } from '@shared/clis'
import { t } from '@shared/i18n'
import { supportTierLabel, type SupportPatch } from '@shared/models/support'
import type { HooksView } from '@/lib/api-hooks'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Group, Row } from './parts'

type SupportView = NonNullable<HooksView['modelSupport']>
type SupportRow = SupportView['items'][number]

/** 表里从弱到强排：弱档是这张表的重点，放最左边 */
const TIERS: ModelTier[] = ['low', 'medium', 'high']

/**
 * 设置 →「钩子」里的「按模型档位加强扶持」（shared/models/support.ts）：一项一行、一档一列，每格都能改，
 * 改过的格子标出来（和默认值不一样）。只往严里推：每一项和上面的档位、钩子参数取更强的，所以这里调低不会让钩子变松
 */
export function ModelSupportGroup({
  view,
  busy,
  onPatch,
}: {
  view: SupportView
  busy: boolean
  onPatch: (p: SupportPatch) => void
}) {
  return (
    <Group title={t('按模型档位加强扶持')}>
      <Row
        title={t('自动加强')}
        desc={t('角色或节点选了高、中、低档时按选的档套用下面这一列；直接写了模型名的按模型目录里的档')}
        hint={t(
          '弱模型（例如 deepseek-flash）守不住长规则，面板替它多做几件事：严格档钩子、先列计划、多推几条情境规则、计划没跟上早点提醒。只往严里推，项目里手动选的钩子档位优先；对话的会话栏会写「已按弱模型加强扶持」',
        )}
      >
        <Switch
          checked={view.enabled}
          disabled={busy}
          onCheckedChange={(on) => onPatch({ enabled: on })}
          aria-label={t('自动加强')}
        />
      </Row>
      <div className={cn('flex items-center gap-2 py-2 text-footnote text-subtle', !view.enabled && 'opacity-50')}>
        <span className="min-w-0 flex-1 pl-1">{t('模型档位')}</span>
        <div className="grid w-[280px] shrink-0 grid-cols-3 gap-1.5 text-center">
          {TIERS.map((tier) => (
            <span key={tier}>{supportTierLabel(tier)}</span>
          ))}
        </div>
      </div>
      {view.items.map((it) => (
        <Row key={it.key} title={it.label} hint={it.hint}>
          <div className={cn('grid w-[280px] grid-cols-3 gap-1.5', !view.enabled && 'opacity-50')}>
            {TIERS.map((tier) => (
              <SupportCell
                key={tier}
                item={it}
                tier={tier}
                disabled={busy || !view.enabled}
                onChange={(value) => onPatch({ tier, key: it.key, value })}
              />
            ))}
          </div>
        </Row>
      ))}
    </Group>
  )
}

/** 一格：选项用下拉，数字用数字框（失焦或回车才保存，免得一边输一边存） */
function SupportCell({
  item,
  tier,
  disabled,
  onChange,
}: {
  item: SupportRow
  tier: ModelTier
  disabled: boolean
  onChange: (v: string | number) => void
}) {
  const value = item.values[tier]
  const changed = value !== item.defaults[tier]
  const label = `${item.label} · ${supportTierLabel(tier)}`
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  if (item.kind === 'choice')
    return (
      <Select
        size="sm"
        className={cn('w-full', changed && 'text-accent-text')}
        value={String(value)}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        options={(item.choices ?? []).map((c) => ({ value: c.id, label: c.label }))}
      />
    )
  const commit = () => {
    const n = Number(text)
    if (Number.isInteger(n) && n !== value) onChange(n)
    else setText(String(value))
  }
  return (
    <Input
      size="sm"
      inputMode="numeric"
      value={text}
      disabled={disabled}
      aria-label={label}
      title={t('{min} 到 {max}', { min: item.min ?? 1, max: item.max ?? 100 })}
      className={cn('text-right tabular-nums', changed && 'text-accent-text')}
      onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}
