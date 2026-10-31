import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import type { DirBranches } from '@shared/schema'
import { api } from '@/lib/api'
import { Field, Select } from '@/components/ui/input'
import { DirPicker, useDirInfo } from './DirPicker'

/**
 * 项目设置里的 cherry-pick 目标（用户要求）：Git 项目从本地分支里下拉选，P4 项目填目标工作区里的项目路径（可以浏览选目录），
 * 其他情况说明不能设。Agent 被要求 cherry-pick 时按这里的目标做（见 shared/engine.ts 的 cherryPickPart）
 */
export function CherryPickTarget({
  vcs,
  path,
  value,
  onChange,
}: {
  vcs: 'git' | 'p4' | 'svn' | 'none'
  path: string
  value: string
  onChange: (v: string) => void
}) {
  const [branches, setBranches] = useState<DirBranches | null>(null)
  const p4Info = useDirInfo(vcs === 'p4' ? value : '')
  useEffect(() => {
    if (vcs !== 'git' || !path) return setBranches(null)
    let alive = true
    api
      .dirBranches(path)
      .then((r) => alive && setBranches(r))
      .catch(() => alive && setBranches({ current: null, branches: [] }))
    return () => {
      alive = false
    }
  }, [vcs, path])
  if (vcs === 'p4')
    return (
      <DirPicker
        label={t('目标项目路径')}
        value={value}
        onChange={onChange}
        info={p4Info}
        hint={t('P4 项目：填要 cherry-pick 过去的那条分支在本机的项目目录（目标工作区里的同一个项目）。')}
      />
    )
  if (vcs !== 'git')
    return (
      <p className="text-xs text-subtle">
        {path ? t('项目目录不是 Git 仓库或 P4 工作区，不能设置。') : t('先选好本地目录。')}
      </p>
    )
  // 已经存下的分支本地没有了（被删、换了机器）也列出来，免得打开设置就被悄悄清掉
  const list = branches?.branches ?? []
  const options = [
    { value: '', label: t('不设置') },
    ...(value && !list.includes(value) ? [{ value, label: t('{name}（本地没有这个分支）', { name: value }) }] : []),
    ...list.filter((b) => b !== branches?.current).map((b) => ({ value: b, label: b })),
  ]
  return (
    <Field
      label={t('目标分支')}
      hint={t('Git 项目：让 Agent cherry-pick 时提交到这个本地分支（当前所在的分支不列出）。')}
    >
      <Select aria-label={t('目标分支')} value={value} onChange={(e) => onChange(e.target.value)} options={options} />
    </Field>
  )
}
