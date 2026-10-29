import { t } from '@shared/i18n'
import { Segmented } from '@/components/ui/segmented'

export type RoleLayer = 'advanced' | 'basic'

/** 角色列表的两层分页：在前面的是高级角色（对话的负责人），后面是基本角色（被挂载、派出的能力） */
export const ROLE_LAYERS: RoleLayer[] = ['advanced', 'basic']

export const roleLayerLabel = (l: RoleLayer) => (l === 'advanced' ? t('高级角色') : t('基本角色'))

/**
 * 角色页列表栏顶上的「高级角色 / 基本角色」分页。条数跟着搜索和标签筛选走，
 * 当前页没有命中时一眼能看出另一页有没有
 */
export function RoleLayerTabs({
  value,
  onChange,
  counts,
}: {
  value: RoleLayer
  onChange: (v: RoleLayer) => void
  counts: Record<RoleLayer, number>
}) {
  return (
    <Segmented
      fill
      size="sm"
      label={t('角色层')}
      value={value}
      onChange={onChange}
      options={ROLE_LAYERS.map((id) => ({ id, label: `${roleLayerLabel(id)} · ${counts[id]}` }))}
    />
  )
}
