import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CLIS } from '@shared/clis'
import { t } from '@shared/i18n'
import type { PluginActivation } from '@shared/projects/capabilities'
import type { LibraryItem } from '@shared/library'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Segmented } from '@/components/ui/segmented'

/**
 * 技能的生效方式（工作包 W4，见 shared/skills/activation.ts）：全局，或按项目。
 * 按项目的不放在用户目录，只给在项目「能力」里打开了它的项目每轮带上；技能库页、自带 Skill 页都用这一行。
 * 按技能名切：同名的自带技能和各 CLI 目录里的同名技能一起切
 */
export function SkillActivation({
  name,
  value,
  onChanged,
}: {
  name: string
  value: PluginActivation | undefined
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const cur = value ?? 'global'
  // CLI 定义里没写 runSkills 的不能按会话加载技能：面板改成在提示里列出路径，在这里说明白
  const listed = CLIS.filter((d) => !d.runSkills).map((d) => d.name)
  const change = async (next: PluginActivation) => {
    if (next === cur || busy) return
    setBusy(true)
    try {
      const r = await api.setSkillActivation({ name, activation: next })
      if (r.kept.length)
        toast.warning(
          next === 'project'
            ? t('已改成按项目。下面这些被改过或目标已有同名的，留在原处没动，仍对所有项目生效：{list}', {
                list: r.kept.join(t('、')),
              })
            : t('已改回全局。下面这些目标已有同名的，没挪回去：{list}', { list: r.kept.join(t('、')) }),
        )
      else toast.success(next === 'project' ? t('已改成按项目') : t('已改回全局'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-footnote text-subtle">{t('生效')}</span>
      <Segmented
        size="sm"
        label={t('技能的生效方式')}
        value={cur}
        onChange={(v) => void change(v)}
        options={[
          { id: 'global', label: t('全局'), disabled: busy },
          { id: 'project', label: t('按项目'), disabled: busy },
        ]}
      />
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-subtle" />}
      <span className="min-w-0 text-footnote text-subtle">
        {cur === 'project'
          ? t('只在项目「能力」里打开了它的项目里交给 Agent，每轮带上，不放在用户目录')
          : t('放在用户目录，所有项目、所有对话都读得到')}
        {cur === 'project' &&
          listed.length > 0 &&
          t('；{clis} 不能按会话加载技能，改成在提示里列出它的路径', { clis: listed.join(t('、')) })}
      </span>
    </div>
  )
}

/** 技能库里同名的几份（各 CLI 一份）中，当前这一份的生效方式：生效方式按名字切，几份本来就一样 */
export const activationIn = (here: LibraryItem[], cli: string) =>
  (here.find((i) => i.cli === cli) ?? here[0])?.activation
