import { useState, type ComponentType, type ReactNode } from 'react'
import type { CompName } from '@shared/component-style'
import { t } from '@shared/i18n'
import { BUILTIN_STYLES } from '@shared/styles'
import { StylePicker, StyleOption } from '@/components/ui/style-picker'
import { StyleThumb } from '@/components/ui/style-thumb'
import { CallTreeSpecimen } from './CallTreeSpecimen'
import { StructureSpecimen } from './StructureSpecimen'
import { Group } from './parts'

/**
 * 设置 →「控件样式」里看图类部件的几组样张：调用栈树、功能结构、风格参考图和风格选择。
 * 从 ComponentsSection 挪出来（那个函数到了行数基线），示例外框 Specimen 由组件页传进来
 */
export function ReferenceSpecimens({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  return (
    <>
      <Group title={t('调用栈')}>
        <Specimen name="calltree" tune={['callTree']}>
          <CallTreeSpecimen />
        </Specimen>
      </Group>
      <Group title={t('功能结构')}>
        <Specimen name="structure" tune={['structure', 'segmented']}>
          <StructureSpecimen />
        </Specimen>
      </Group>
      <Group title={t('风格参考图 · 风格选择')}>
        <Specimen name="StylePicker · StyleThumb · StyleOption" tune={['styleRef', 'chip', 'popover']}>
          <StyleRefSpecimen />
        </Specimen>
      </Group>
    </>
  )
}

/**
 * 设置 →「控件样式」里的风格参考图和风格选择样张：用内置风格（不请求接口），
 * 上面是选择标签（模型设计页、模型对话里用的那个），下面是缩略图三种尺寸和列表行
 */
export function StyleRefSpecimen() {
  const models = BUILTIN_STYLES.filter((s) => s.kind === 'model')
  const [value, setValue] = useState(models[1]?.id ?? '')
  const cur = models.find((s) => s.id === value) ?? models[0]!
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <StylePicker styles={BUILTIN_STYLES} kind="model" value={value} onChange={(s) => setValue(s.id)} />
        <StylePicker styles={BUILTIN_STYLES} kind="game" value="builtin-game-dark-fantasy" onChange={() => {}} />
      </div>
      <div className="flex items-end gap-3">
        <StyleThumb style={cur} size="sm" />
        <StyleThumb style={cur} size="md" />
        <StyleThumb style={cur} size="lg" className="max-w-56" />
      </div>
      <div
        role="listbox"
        aria-label={t('风格')}
        className="flex max-w-sm flex-col gap-0.5 rounded-(--c-popover-radius) bg-(--c-popover-bg) p-1 shadow-pop"
      >
        {models.slice(0, 3).map((s) => (
          <StyleOption key={s.id} s={s} on={s.id === value} onPick={() => setValue(s.id)} />
        ))}
      </div>
    </div>
  )
}
