import { useEffect, useRef } from 'react'
import { FileIndexSettings, type FileIndexWatch } from '@shared/file-index/types'
import { t } from '@shared/i18n'
import { ParamRow } from '@/components/agents/ParamFields'
import { Checkbox } from '@/components/ui/checkbox'
import { ChipListInput } from '@/components/ui/chip-list-input'
import { Field, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FileIndexStatusCard } from './FileIndexStatusCard'
import type { Vcs } from './project-draft'

type Value = Partial<FileIndexSettings> | undefined

/**
 * 项目设置 →「常规 · 搜索」里的文件索引：开关、状态卡、收录哪些文件、盯着改动、额外收录的目录。
 * 只存和默认值不同的项（没改过的项目 fileIndex 留空），默认值见 shared/file-index/types.ts
 */
export function FileIndexField({
  projectId,
  value,
  onChange,
  vcs,
  focus,
}: {
  /** 打开设置时滚到这里（侧栏底部的索引状态点进来） */
  focus?: boolean
  /** 新建项目时没有：不显示状态卡 */
  projectId?: string
  value: Value
  onChange: (v: Value) => void
  vcs: Vcs
}) {
  const s = FileIndexSettings.parse(value ?? {})
  const set = <K extends keyof FileIndexSettings>(k: K, v: FileIndexSettings[K]) => {
    const next = { ...value, [k]: v }
    // 和默认值一样的项不存，全是默认值时整个留空
    const def = FileIndexSettings.parse({})
    for (const key of Object.keys(next) as (keyof FileIndexSettings)[])
      if (JSON.stringify(next[key]) === JSON.stringify(def[key])) delete next[key]
    onChange(Object.keys(next).length ? next : undefined)
  }
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus) box.current?.scrollIntoView({ block: 'start' })
  }, [focus])
  const vcsName = vcs === 'git' ? 'Git' : vcs === 'p4' ? 'P4' : vcs === 'svn' ? 'SVN' : ''
  return (
    <div ref={box} className="flex scroll-mt-4 flex-col gap-4">
      <div className="flex items-start gap-4">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-body font-medium">{t('文件索引')}</span>
          <span className="text-xs leading-relaxed text-subtle">
            {t(
              '记下项目里每个文件的名字和位置（不读内容），按名字找文件、列某个文件夹时直接查它，不用每次扫目录。Agent 找文件也先查它。',
            )}
          </span>
        </span>
        <Switch aria-label={t('文件索引')} checked={s.enabled} onCheckedChange={(v) => set('enabled', v)} />
      </div>
      {s.enabled && (
        <>
          {projectId && <FileIndexStatusCard key={projectId} projectId={projectId} />}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={t('收录哪些文件')}
              tip={t(
                '「磁盘上的全部」按磁盘收，跳过下面的排除目录（Git 项目还跳过 .gitignore 忽略的），刚新建、还没加进版本管理的文件也找得到。「只收版本管理里的」只收已经提交 / 签入的文件。',
              )}
            >
              <Select
                aria-label={t('收录哪些文件')}
                value={s.vcsOnly ? 'vcs' : 'disk'}
                onChange={(e) => set('vcsOnly', e.target.value === 'vcs')}
                options={[
                  { value: 'disk', label: t('磁盘上的全部（跳过排除目录）') },
                  {
                    value: 'vcs',
                    label: vcsName ? t('只收 {vcs} 里的', { vcs: vcsName }) : t('只收版本管理里的'),
                  },
                ]}
              />
            </Field>
            <Field
              label={t('盯着改动')}
              tip={t(
                '自动：Windows、macOS 用系统的文件通知，改了马上进索引；Linux 不盯，查询时按目录核对。面板和 Agent 自己改的文件总是马上进索引。',
              )}
            >
              <Select
                aria-label={t('盯着改动')}
                value={s.watch}
                onChange={(e) => set('watch', e.target.value as FileIndexWatch)}
                options={[
                  { value: 'auto', label: t('自动') },
                  { value: 'on', label: t('总是用系统通知') },
                  { value: 'off', label: t('不盯，按目录核对') },
                ]}
              />
            </Field>
          </div>
          <ParamRow
            label={
              <>
                <span className="truncate font-medium text-muted">{t('额外收录的目录')}</span>
                <span className="shrink-0 text-caption text-subtle">{t('项目外也可以')}</span>
              </>
            }
            hint={t('绝对路径，或相对项目根。项目外的文档根（ProjectDoc/docs）会自动加，不用写在这里。')}
            stacked
          >
            <ChipListInput
              value={s.extraRoots}
              onChange={(v) => set('extraRoots', v)}
              label={t('额外收录的目录')}
              placeholder={t('目录路径，回车添加')}
              clean={(x) => x.trim().replace(/[\\/]+$/, '')}
              inputClass="w-[16rem]"
            />
          </ParamRow>
          <Checkbox
            checked={s.pluginRoots}
            onChange={(v) => set('pluginRoots', v)}
            label={t('也收插件报来的目录')}
            tip={t('例如 UE 插件报的引擎目录：找引擎里的头文件、插件也走索引。引擎目录大，第一次建要多花些时间。')}
          />
        </>
      )}
    </div>
  )
}
