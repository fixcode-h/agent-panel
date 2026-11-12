import type { Project, ProjectInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { usePluginProjectSections } from '@/plugins/registry'
import type { useDirInfo } from '../DirPicker'
import type { SetField } from './project-draft'

/**
 * 项目设置里插件加的页（插件接口 6，WebPlugin.projectSections）：插件只读写草稿里 plugins[<插件 id>] 这一格，
 * 跟别的设置一起点「保存」落盘。插件关掉、删掉后这一页不见了，地址还停在它上面时说明一句
 */
export function PluginSectionPage({
  section,
  project,
  draft,
  set,
  dir,
}: {
  /** plugin:<插件 id>:<页 id> */
  section: string
  project?: Project
  draft: ProjectInput
  set: SetField
  dir: ReturnType<typeof useDirInfo>
}) {
  const page = usePluginProjectSections().find((p) => p.key === section)
  if (!page) return <p className="text-sm text-muted">{t('这一页来自的插件已经关掉或删除了')}</p>
  const { Section, plugin } = page
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <Section
        value={draft.plugins?.[plugin]}
        onChange={(v) => set('plugins', { ...draft.plugins, [plugin]: v })}
        project={project}
        base={dir?.exists && dir.isDir ? dir.path : draft.path.trim()}
      />
    </div>
  )
}
