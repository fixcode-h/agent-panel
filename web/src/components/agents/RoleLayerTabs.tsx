import { t } from '@shared/i18n'
import { roleKind } from '@shared/agents/role'
import { scopeOf } from '@shared/conv-mode'
import type { Agent } from '@shared/schema'
import { Segmented } from '@/components/ui/segmented'

export type RoleLayer = 'advanced' | 'basic' | 'chat'

/**
 * 角色列表的三页：前两页是 Agent 角色（项目里的对话用）——高级角色（对话的负责人）、基本角色（被挂载、派出的能力）；
 * 最后一页是 Chat 角色（只在 Chat 页用，ADR 0038）
 */
export const ROLE_LAYERS: RoleLayer[] = ['advanced', 'basic', 'chat']

/** 分页上的短名：300px 的列表栏放三段，写全「高级角色 · N」会折成两行；完整说法在详情头的徽标和能力页 */
export const roleLayerLabel = (l: RoleLayer) => (l === 'advanced' ? t('高级') : l === 'basic' ? t('基本') : t('Chat'))

/** 角色在哪一页：Chat 角色单独一页，Agent 角色按层分 */
export const layerOf = (a: Pick<Agent, 'scope' | 'kind' | 'canDelegate' | 'canPlan' | 'mounts'>): RoleLayer =>
  scopeOf(a) === 'chat' ? 'chat' : roleKind(a)

/**
 * 角色页列表栏顶上的「高级角色 / 基本角色 / Chat 角色」分页。条数跟着搜索和标签筛选走，
 * 当前页没有命中时一眼能看出别的页有没有
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
