import type { ComponentType, ReactNode } from 'react'
import { COMP_SPEC, type CompName } from '@shared/component-style'
import { t } from '@shared/i18n'
import { usePlugins, usePluginSpecimens } from '@/plugins/registry'
import { Group } from './parts'

/**
 * 设置 →「组件」里开着的插件登记的示例（插件接口 6，WebPlugin.specimens）：每个插件一组，标题是插件名。
 * 示例的外框（名字、微调按钮）用组件页同一个 Specimen，由调用方传进来；插件写的部件名不认识的忽略。
 * 组名后面标「（插件）」：插件名可能和面板自己的组重名（表格插件和面板的「表格」组），页签上要分得开
 */
export function PluginSpecimens({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  const list = usePluginSpecimens()
  const { rows } = usePlugins()
  const plugins = [...new Set(list.map((s) => s.plugin))]
  return plugins.map((id) => (
    <Group
      key={id}
      title={t('{name}（插件）', { name: t(rows.find((r) => r.manifest.id === id)?.manifest.name ?? id) })}
    >
      {list
        .filter((s) => s.plugin === id)
        .map((s) => {
          const tune = s.tune?.filter((n): n is CompName => n in COMP_SPEC)
          return (
            <Specimen key={s.id} name={s.label} tune={tune?.length ? tune : undefined}>
              <s.Specimen />
            </Specimen>
          )
        })}
    </Group>
  ))
}
