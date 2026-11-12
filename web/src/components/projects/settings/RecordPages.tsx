import type { Project, ProjectInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { ProjectExperience } from '../ProjectExperience'
import { ProjectTablesSection } from '../ProjectTablesSection'
import { LessonsEditor } from '../Lessons'
import type { useDirInfo } from '../DirPicker'
import { PageIntro } from './parts'
import type { SetField } from './project-draft'

/*
 * 项目设置里只有一段说明加一个编辑器的几页：表格、项目教训、项目经验（从 ProjectSettingsDialog.tsx 挪出）。
 */

/** 项目设置 →「表格」：只读写草稿里的 tables */
export function TablesPage({
  project,
  draft,
  set,
  dir,
}: {
  project?: Project
  draft: ProjectInput
  set: SetField
  dir: ReturnType<typeof useDirInfo>
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('表格')}
        desc={t(
          '游戏配置表这类表格的目录。设好后侧栏多一个「表格」入口：按目录浏览、搜索、筛选、在线改单元格、看版本差异、跨项目对比。保存改动只改单元格的值，文件仍是原来的 Excel / WPS 格式。',
        )}
      />
      <ProjectTablesSection
        value={draft.tables}
        onChange={(v) => set('tables', v)}
        project={project}
        base={dir?.exists && dir.isDir ? dir.path : draft.path.trim()}
        path={draft.path}
      />
    </div>
  )
}

/** 项目设置 →「项目教训」：只读写草稿里的 lessons */
export function LessonsPage({
  project,
  draft,
  set,
  item,
}: {
  project?: Project
  draft: ProjectInput
  set: SetField
  /** 打开时要展开的那条 */
  item?: string
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('项目教训')}
        desc={t(
          '角色在这个项目里返工过、走过弯路的地方，写成下次能直接照做的规则。被纠正、或自己发现办法不对换了做法时，角色会自己记一条，标「角色记录」；你的新要求和某条冲突时，角色会找两全的做法改写它，找不到就先问你。新会话开头只带「所有改动」的全文和其余条目的标题，改到哪些文件再取对应的全文。优先级：你当次的要求 > 项目教训 > 全局教训。',
        )}
      />
      <LessonsEditor lessons={draft.lessons} onChange={(v) => set('lessons', v)} project={project} initialOpen={item} />
    </div>
  )
}

/** 项目设置 →「项目经验」：不在草稿里，改动直接保存 */
export function ExperiencePage({ project, item }: { project: Project; item?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('项目经验')}
        desc={t(
          '做某类事最快的路：在哪个目录找、你的说法在代码里叫什么、用什么命令、怎么验证。整个对话完成后面板自动学，学到就加；对话里发「/learn 要学的」也能让角色专门学一条。Agent 需要时按关键词查，不会整份塞进提示词。这里的改动直接保存。',
        )}
      />
      <ProjectExperience projectId={project.id} initialOpen={item} />
    </div>
  )
}
