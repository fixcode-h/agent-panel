import type { HookTier } from '@shared/hook-defs'
import { t } from '@shared/i18n'
import { Segmented } from '@/components/ui/segmented'
import { Button } from '@/components/ui/button'
import type { HooksView } from '@/lib/api-hooks'
import { Row } from './parts'

/** 档位的名字和一句话说明：设置页、项目设置共用 */
export const tierLabel = (x: HookTier) => ({ minimal: t('精简'), standard: t('标准'), strict: t('严格') })[x]
const TIER_DESC = (): Record<HookTier, string> => ({
  minimal: t('只留保证对话正确、防误操作的守卫'),
  standard: t('再加省上下文、提节奏的提醒（默认）'),
  strict: t('全部打开，适合能力弱一些的模型或重要项目，打扰会多一些'),
})

/**
 * 内置钩子的档位（借鉴 ECC 的钩子档位）：一次把所有内置钩子摆成某一档；之后逐个改的开关照常生效，
 * 这里写「改过 N 个」，点「恢复」回到这一档。看的是某个项目时可以选「跟随全局」
 */
export function HookTierRow({
  view,
  scope,
  busy,
  onPick,
}: {
  view: HooksView
  /** 空是全局，否则是项目 id */
  scope: string
  busy: boolean
  /** null：项目跟随全局 */
  onPick: (tier: HookTier | null) => void
}) {
  const global = view.tier ?? 'standard'
  const following = !!scope && !view.projectTier
  const cur: HookTier = (scope ? view.projectTier : null) ?? global
  const changed = view.tierChanged ?? 0
  const desc = following
    ? t('跟随全局：{tier}。{desc}', { tier: tierLabel(global), desc: TIER_DESC()[global] })
    : TIER_DESC()[cur]
  return (
    <Row
      title={t('档位')}
      desc={changed ? t('{desc}；下面逐个改过 {n} 个', { desc, n: changed }) : desc}
      hint={t('选档位会清掉这一层逐个改过的开关；插件带的钩子和我的钩子不受档位影响')}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {changed > 0 && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPick(following ? null : cur)}>
            {t('恢复')}
          </Button>
        )}
        {scope && !following && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPick(null)}>
            {t('跟随全局')}
          </Button>
        )}
        <Segmented<HookTier>
          size="sm"
          label={t('档位')}
          value={cur}
          onChange={(v) => onPick(v)}
          options={(['minimal', 'standard', 'strict'] as const).map((id) => ({
            id,
            label: tierLabel(id),
            disabled: busy,
          }))}
        />
      </div>
    </Row>
  )
}
