import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { compValue, type CompName } from '@shared/component-style'
import { t } from '@shared/i18n'
import { componentsSnapshot, subscribeComponents } from '@/lib/appearance'
import { ChangesCard, ChangesCardNote, type ChangesScope } from '@/components/ui/changes-card'
import { Group } from './parts'
import { HtmlCardSpecimen } from './HtmlCardSpecimen'
import { FoldBarSpecimen } from './FoldBarSpecimen'

/** 样张数据（不翻译）：这一轮 3 个、整个对话 9 个 */
const ROUND = [
  { path: 'web/src/cart/store.ts', add: 6, del: 3 },
  { path: 'web/src/cart/store.test.ts', add: 11, del: 0, added: true },
  { path: 'web/src/cart/badge.ts', add: 1, del: 1 },
]
const CONV = [
  ...ROUND,
  { path: 'src/components/CartBadge.tsx', add: 5, del: 3 },
  { path: 'src/components/RestockButton.tsx', add: 9, del: 0, added: true },
  { path: 'src/store/cart.ts', add: 4, del: 1 },
  { path: 'src/store/session.ts', add: 12, del: 4 },
  { path: 'tests/cart.test.ts', add: 0, del: 62 },
  { path: 'docs/角标刷新问题-排查记录.md', add: 86, del: 0, added: true },
]

/**
 * 设置 → 组件里的改动卡片样张：分段切「这一轮 / 整个对话」，撤销跟着变；默认看哪一段、先列几个、一开始折不折读这里的设置，
 * 改了马上看得到
 */
export function ChangesCardSpecimen() {
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  const want = compValue(style, 'changesCard', 'scope') === 'conv' ? 'conv' : 'round'
  const [picked, setPicked] = useState<ChangesScope | null>(null)
  const [all, setAll] = useState(false)
  const [unfolded, setUnfolded] = useState<boolean | null>(null)
  const open = unfolded ?? compValue(style, 'changesCard', 'fold') === 'open'
  const scope = picked ?? want
  const files = scope === 'round' ? ROUND : CONV
  return (
    <div className="w-full max-w-3xl">
      <ChangesCard
        title={
          scope === 'round'
            ? t('这一轮改了 {n} 个文件', { n: files.length })
            : t('这个对话改了 {n} 个文件', { n: files.length })
        }
        scope={{ value: scope, onChange: setPicked, round: ROUND.length, conv: CONV.length }}
        files={files}
        first={Number(compValue(style, 'changesCard', 'first')) || 3}
        all={all}
        onAll={() => setAll(!all)}
        reverted={false}
        onOpen={() => {}}
        fold={{ open, onToggle: () => setUnfolded(!open) }}
        revert={{ label: scope === 'round' ? t('撤销这一轮') : t('撤销'), title: '', onClick: () => {} }}
        tag={(p) =>
          p.endsWith('badge.ts') ? (
            <span className="shrink-0 rounded-(--c-badge-radius) bg-accent-soft px-1.5 text-xs text-accent-text">
              {t('排查')}
            </span>
          ) : null
        }
        footer={
          scope === 'round' && (
            <ChangesCardNote>
              {t('这一轮 = 你 {time} 说「{text}」之后到它停下；切到「整个对话」看全部 {n} 个文件', {
                time: '10:58',
                text: '按方案 A 改',
                n: CONV.length,
              })}
            </ChangesCardNote>
          )
        }
      />
    </div>
  )
}

/** 「HTML 卡片 · 本轮产出」一组：对话停下后挂在最后面的几张卡片。Specimen 由组件页传进来，这里只管内容 */
export function TurnCardSpecimens({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  return (
    <Group title={t('HTML 卡片 · 本轮产出')}>
      <Specimen name="HtmlCard · OutputsCard · OutputRow · UrlRow" tune={['htmlCard', 'iconButton']}>
        <HtmlCardSpecimen />
      </Specimen>
      {/* 折叠条：回复收尾后过程收起来的那一行，改动卡片折起来的那一行也是它 */}
      <Specimen name="FoldBar" tune={['foldBar']}>
        <FoldBarSpecimen />
      </Specimen>
      <Specimen name="ChangesCard" tune={['changesCard', 'segmented', 'badge']}>
        <ChangesCardSpecimen />
      </Specimen>
    </Group>
  )
}
