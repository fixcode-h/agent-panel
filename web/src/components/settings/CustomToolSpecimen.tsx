import { useState } from 'react'
import { FolderGit2, Globe } from 'lucide-react'
import { t } from '@shared/i18n'
import type { ToolParam } from '@shared/custom-tools/schema'
import { ScopePicker } from '@/components/ui/scope-picker'
import { paramDefaults, ToolParamForm } from '@/components/ui/tool-param-form'
import { CommandEffectBadge, ToolRunResult } from '@/components/ui/tool-run-result'

/** 设置 → 组件里的自建工具部件样例（ADR 0082）：示例数据不翻译 */
const PARAMS: ToolParam[] = [
  {
    name: 'sheet',
    label: '表名',
    type: 'string',
    desc: '只导这一张，留空导全部',
    required: false,
    options: [],
    inProject: true,
  },
  {
    name: 'platform',
    label: '平台',
    type: 'enum',
    desc: '',
    required: true,
    options: ['Win64', 'Android'],
    default: 'Win64',
    inProject: true,
  },
  { name: 'dry', label: '只演练', type: 'boolean', desc: '', required: false, options: [], inProject: true },
]

export function CustomToolSpecimen() {
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [values, setValues] = useState(() => paramDefaults(PARAMS))
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <ScopePicker
        value={scope}
        onChange={setScope}
        label={t('保存到')}
        options={[
          {
            id: 'project',
            icon: FolderGit2,
            title: '加入项目',
            badge: '推荐',
            desc: '存进文档目录，跟仓库走，大家共用',
            note: 'P4 项目会先签出',
          },
          { id: 'global', icon: Globe, title: '全局', desc: '只在这台电脑，所有项目都能用' },
        ]}
      />
      <ToolParamForm params={PARAMS} values={values} onChange={setValues} />
      <span className="flex gap-1.5">
        <CommandEffectBadge effect="read" />
        <CommandEffectBadge effect="write" />
        <CommandEffectBadge effect="external" />
      </span>
      <ToolRunResult
        ok={false}
        line="python tools/export_tables.py Item --out Content/Config"
        text={'导表 export-tables · 退出码 1 · 1.2s · 失败\n报错 1 处：\n  Item.xlsx:12: 缺列 ID'}
        output={['读取 Item.xlsx…', 'Item.xlsx:12: 缺列 ID']}
      />
    </div>
  )
}
