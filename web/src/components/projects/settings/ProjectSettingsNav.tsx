import {
  FileText,
  FlaskConical,
  GraduationCap,
  Lightbulb,
  Library,
  Plug,
  Settings2,
  Sheet,
  Sparkles,
  Users,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import type { Project, ProjectInput } from '@shared/schema'
import { CLIS } from '@shared/clis'
import { cliDocs, SHARED_DOC } from '@shared/docs'
import { cliSettings, orderClis } from '@shared/settings'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { cliColor } from '@/lib/cli-style'
import { NavItem } from '@/components/ui/dialog-nav'
import type { ProjectDocsState } from './use-project-docs'

/**
 * 项目设置的左边菜单：常规、通用的项目说明、各个 CLI 读的说明文件（从 ProjectSettingsDialog.tsx 挪出）。
 * 只读草稿和说明文件的状态，给各项标点和计数。
 */
export function ProjectSettingsNav({
  section,
  onSection,
  project,
  draft,
  docs,
}: {
  section: string
  onSection: (s: string) => void
  project?: Project
  draft: ProjectInput
  docs: Pick<ProjectDocsState, 'isChanged' | 'hasDoc' | 'docOf'>
}) {
  const { settings } = useData()
  const { isChanged, hasDoc, docOf } = docs
  const setSection = onSection
  // 停用的 CLI 不在项目设置里出现
  const cliPages = orderClis(CLIS, settings?.cliOrder ?? []).filter(
    (c) => c.docs.length && (!settings || cliSettings(settings, c.id).enabled),
  )
  return (
    <nav
      aria-label={t('项目设置分类')}
      className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[244px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3"
    >
      <NavItem on={section === 'general'} onClick={() => setSection('general')}>
        <Settings2 className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('常规')}
      </NavItem>
      <NavItem on={section === 'init'} onClick={() => setSection('init')} dot={!draft.initializedAt}>
        <Sparkles className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('AI 初始化')}
      </NavItem>
      <NavItem
        on={section === 'roles'}
        onClick={() => setSection('roles')}
        dot={Object.values(draft.agentParams).some((v) => Object.keys(v).length > 0)}
      >
        <Users className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('必备角色')}
      </NavItem>
      <NavItem on={section === 'workflows'} onClick={() => setSection('workflows')}>
        <WorkflowIcon className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('工作流')}
      </NavItem>
      <NavItem
        on={section === 'tests'}
        onClick={() => setSection('tests')}
        hint={draft.testSteps.length ? t('{n} 步', { n: draft.testSteps.length }) : undefined}
      >
        <FlaskConical className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('测试步骤')}
      </NavItem>
      <NavItem
        on={section === 'lessons'}
        onClick={() => setSection('lessons')}
        hint={draft.lessons.length ? t('{n} 条', { n: draft.lessons.length }) : undefined}
      >
        <GraduationCap className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('项目教训')}
      </NavItem>
      {project?.path && (
        <NavItem on={section === 'experience'} onClick={() => setSection('experience')}>
          <Lightbulb className="h-4 w-4 shrink-0" strokeWidth={2.2} />
          {t('项目经验')}
        </NavItem>
      )}
      <NavItem on={section === 'tables'} onClick={() => setSection('tables')} hint={draft.tables?.dirs[0]}>
        <Sheet className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('表格')}
      </NavItem>
      <NavItem on={section === 'skills'} onClick={() => setSection('skills')}>
        <Library className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        Skill
      </NavItem>
      <NavItem on={section === 'mcp'} onClick={() => setSection('mcp')}>
        <Plug className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('MCP')}
      </NavItem>
      <NavItem
        on={section === 'doc'}
        onClick={() => setSection('doc')}
        dot={isChanged([SHARED_DOC, 'AGENT.md'])}
        hint={hasDoc([SHARED_DOC]) ? SHARED_DOC : undefined}
      >
        <FileText className="h-4 w-4 shrink-0" strokeWidth={2.2} />
        {t('项目说明')}
      </NavItem>
      <span className="hidden px-2.5 pt-4 pb-1 text-caption text-subtle md:block">{t('各个 Agent 读的说明')}</span>
      {cliPages.map((c) => (
        <NavItem
          key={c.id}
          on={section === `cli:${c.id}`}
          onClick={() => setSection(`cli:${c.id}`)}
          dot={isChanged(cliDocs(c.id))}
          hint={cliDocs(c.id).find((f) => docOf(f)?.exists)}
        >
          <span className="h-4 w-4 shrink-0 rounded-[4px]" style={{ background: cliColor(c.id) }} />
          {c.name}
        </NavItem>
      ))}
    </nav>
  )
}
