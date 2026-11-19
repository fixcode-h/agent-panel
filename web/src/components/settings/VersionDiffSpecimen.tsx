import { useState, type ComponentType, type ReactNode } from 'react'
import type { CompName } from '@shared/component-style'
import { t } from '@shared/i18n'
import { Group } from './parts'
import { SheetSpecimen } from './SheetSpecimen'
import { DirListSpecimen } from './DirListSpecimen'
import { VersionNav, type VersionList, type VersionPick } from '@/components/ui/version-diff'

/** 样张数据（不翻译） */
const LIST: VersionList = {
  vcs: 'p4',
  revs: [
    {
      id: '#3',
      label: '#1221205',
      author: 'jiafeng',
      time: '2026-10-26T14:59:58Z',
      message: '调整木箱交互角度、加重置盒',
    },
    {
      id: '#2',
      label: '#1218877',
      author: 'yuli',
      time: '2026-10-24T07:12:00Z',
      message: '交互提示改用 WidgetComponent，顺手整理了组件层级和碰撞预设',
    },
    {
      id: '#1',
      label: '#1216326',
      author: 'silver_ci_robot02',
      time: '2026-10-22T04:13:33Z',
      message: 'Initial branch',
    },
  ],
}

/** 设置 → 组件里版本差异弹窗左栏的样张：默认宽度、提交说明几行改了马上看得到 */
export function VersionDiffSpecimen() {
  const [pick, setPick] = useState<VersionPick>(0)
  return (
    <div className="flex h-72 w-72 flex-col gap-0.5 overflow-y-auto rounded-(--c-card-radius) border bg-card p-2">
      <VersionNav
        list={LIST}
        pick={pick}
        onPick={setPick}
        local={{ meta: t('含还没保存的'), message: t('最近一次提交 ↔ 现在页面上的内容') }}
        tags={{
          '#3': <span className="rounded-(--c-badge-radius) bg-sel px-1.5 text-caption text-muted">{t('属性 4')}</span>,
        }}
      />
    </div>
  )
}

/** 设置 → 组件的「表格」一组：数据表格、版本差异左栏、目录列表 */
export function SheetGroupSpecimens({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  return (
    <Group title={t('表格')}>
      <Specimen name="SheetTable · SheetHeaderBar" tune={['grid']}>
        <SheetSpecimen />
      </Specimen>
      <Specimen name="VersionDiffShell · VersionNav" tune={['versionDiff', 'row']}>
        <VersionDiffSpecimen />
      </Specimen>
      <Specimen name="DirList" tune={['input', 'button']}>
        <DirListSpecimen />
      </Specimen>
    </Group>
  )
}
