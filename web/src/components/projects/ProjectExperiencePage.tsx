import { GraduationCap } from 'lucide-react'
import type { Project } from '@shared/schema'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { PageFrame } from '@/components/library/parts'
import { ProjectExperience } from './ProjectExperience'
import { experienceIntro } from './settings/RecordPages'

/**
 * 项目工具里的「经验与文档」（#/projects/<id>/experience）：和项目设置 →「项目经验」显示同一份内容、用同一个编辑器
 * （ProjectExperience，改动直接保存），只是放在右边的整页里，不再弹出项目设置
 */
export function ProjectExperiencePage({ project }: { project: Project }) {
  const { openProject } = useNav()
  return (
    <PageFrame
      align="left"
      title={t('经验与文档 · {name}', { name: project.name })}
      intro={experienceIntro()}
      actions={
        <Button variant="secondary" onClick={() => openProject(project.id, 'lessons')}>
          <GraduationCap className="h-4 w-4" />
          {t('项目教训')}
        </Button>
      }
    >
      {project.path ? (
        <ProjectExperience key={project.id} projectId={project.id} />
      ) : (
        <EmptyPanel size="md">{t('项目还没设本地目录，先在项目设置里选目录。')}</EmptyPanel>
      )}
    </PageFrame>
  )
}
