import { t } from '@shared/i18n'
import type { RestoreThresholds } from '@shared/restore/thresholds'
import { Select } from '@/components/ui/input'
import { Group, Row } from './parts'

/** UI 设计照原画还原的门槛：校验一步按它判过不过关，精修出来的切图低于相似度门槛不选用 */
export function RestoreSettings({
  value,
  onChange,
}: {
  value: RestoreThresholds
  onChange: (v: RestoreThresholds) => void
}) {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  return (
    <Group title={t('原画还原')}>
      <Row
        title={t('位置误差')}
        desc={t('控件和原画差几像素以内算对上')}
        hint={t('按设计稿像素算，位置和大小都看。默认 2 像素')}
      >
        <Select
          aria-label={t('位置误差')}
          value={String(value.posPx)}
          onChange={(e) => onChange({ ...value, posPx: Number(e.target.value) })}
          className="w-[240px]"
          options={[0, 1, 2, 3, 4, 6, 8, 12].map((n) => ({
            value: String(n),
            label: n === 2 ? t('{n} 像素（默认）', { n }) : t('{n} 像素', { n }),
          }))}
        />
      </Row>
      <Row
        title={t('达标比例')}
        desc={t('对上的元素至少占多少才算过关')}
        hint={t('校验一步没过关时要你确认接受哪些差异。默认 95%')}
      >
        <Select
          aria-label={t('达标比例')}
          value={String(value.posRatio)}
          onChange={(e) => onChange({ ...value, posRatio: Number(e.target.value) })}
          className="w-[240px]"
          options={[0.8, 0.85, 0.9, 0.95, 0.98, 1].map((n) => ({
            value: String(n),
            label: n === 0.95 ? t('{n}（默认）', { n: pct(n) }) : pct(n),
          }))}
        />
      </Row>
      <Row
        title={t('切图相似度')}
        desc={t('切图和原画那一块至少多像')}
        hint={t('精修（照着原画重画）出来的切图低于它就不选用，仍用原画里抠的那版。默认 92%')}
      >
        <Select
          aria-label={t('切图相似度')}
          value={String(value.assetSim)}
          onChange={(e) => onChange({ ...value, assetSim: Number(e.target.value) })}
          className="w-[240px]"
          options={[0.8, 0.85, 0.88, 0.9, 0.92, 0.95, 0.98].map((n) => ({
            value: String(n),
            label: n === 0.92 ? t('{n}（默认）', { n: pct(n) }) : pct(n),
          }))}
        />
      </Row>
    </Group>
  )
}
