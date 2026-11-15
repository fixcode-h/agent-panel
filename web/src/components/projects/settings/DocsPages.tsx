import type { Project, ProjectInput } from '@shared/schema'
import { CLIS } from '@shared/clis'
import { SHARED_DOC, cliDocs } from '@shared/docs'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { dialogScrollClass } from '@/components/ui/dialog'
import { CliSkills } from '@/components/settings/CliSkills'
import { DocPage } from '../ProjectDocs'
import { ProjectCliTrust } from '../ProjectCliTrust'
import { ProjectPackages } from '../ProjectPackages'
import type { ProjectDocsState } from './use-project-docs'
import type { SetField } from './project-draft'

/*
 * 项目设置里直接读写项目目录的几页：项目说明和各个 Agent 读的说明（从 ProjectSettingsDialog.tsx 挪出；
 * 原来的 MCP、Skill 两页挪到了项目工具的「技能与 MCP」页，见 ../caps/ProjectCapsPage.tsx）。
 * 都要按保存过的目录读写：新建项目、目录改了没保存时只显示一句提示。
 */

/**
 * 项目设置 →「项目说明」和各个 Agent 读的说明（section 是 doc 或 cli:<id>）。
 * 说明文件的草稿在弹窗上（底栏要显示改了几个，确认时一起存）；CLI 页的信任设置写进草稿的 cliTrust。
 */
export function DocsPane({
  section,
  project,
  draft,
  set,
  docs: d,
}: {
  section: string
  project?: Project
  draft: ProjectInput
  set: SetField
  docs: ProjectDocsState
}) {
  const { docs, docOf, docDrafts, setDocDrafts } = d
  return (
    <div className={dialogScrollClass}>
      {!d.docsReady || !docs ? (
        <p className="text-body leading-relaxed text-subtle">
          {!project
            ? t('先创建项目，再编辑项目里的说明文件。')
            : !project.path || draft.path.trim() !== project.path
              ? t('本地目录改了，先点「确认」保存，再编辑新目录里的说明文件。')
              : d.docError || t('正在读取…')}
        </p>
      ) : section === 'doc' ? (
        <DocPage
          key="doc"
          projectId={project!.id}
          title={t('项目说明')}
          desc={t(
            'AGENTS.md 放在项目根目录，Codex 和 Command Code 每次启动都会读它，写这个项目的约定、常用命令和注意事项。Claude Code 读的是 CLAUDE.md，可以在左边的 Claude Code 里编辑，或在 CLAUDE.md 里写一行 @AGENTS.md 引用它。',
          )}
          files={[SHARED_DOC]}
          docs={docs.files}
          drafts={docDrafts}
          onDraft={(f, c) => setDocDrafts((d) => ({ ...d, [f]: c }))}
          note={
            docOf('AGENT.md')?.exists &&
            !docOf(SHARED_DOC)?.exists && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warning/10 px-3.5 py-2.5 text-body">
                <span className="min-w-0 flex-1">
                  {t('检测到 AGENT.md，但各个 Agent 只读 AGENTS.md（多一个 s），现在这个文件不会被读到。')}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDocDrafts((d) => ({ ...d, [SHARED_DOC]: docOf('AGENT.md')!.content }))}
                >
                  {t('复制到 AGENTS.md')}
                </Button>
              </div>
            )
          }
        />
      ) : (
        (() => {
          const id = section.slice(4)
          const name = CLIS.find((c) => c.id === id)?.name ?? id
          const files = cliDocs(id)
          return (
            <DocPage
              key={section}
              projectId={project!.id}
              title={name}
              desc={CLIS.find((c) => c.id === id)?.docsNote ?? ''}
              files={files}
              docs={docs.files}
              drafts={docDrafts}
              onDraft={(f, c) => setDocDrafts((d) => ({ ...d, [f]: c }))}
              extra={
                <>
                  {CLIS.find((c) => c.id === id)?.trust && (
                    <ProjectCliTrust
                      cli={id}
                      name={name}
                      projectId={project?.id}
                      value={draft.cliTrust?.[id]}
                      onChange={(v) => {
                        const { [id]: _, ...rest } = draft.cliTrust ?? {}
                        set('cliTrust', v ? { ...rest, [id]: v } : rest)
                      }}
                    />
                  )}
                  {project && CLIS.find((c) => c.id === id)?.packages?.local && (
                    <ProjectPackages
                      def={CLIS.find((c) => c.id === id)!}
                      projectId={project.id}
                      trusted={draft.cliTrust?.[id] === 'approve'}
                    />
                  )}
                  <section className="flex flex-col gap-2 pt-6">
                    <h3 className="text-body font-medium">Skills</h3>
                    <p className="text-footnote text-muted">
                      {t('{cli} 在这个项目里能用的 Skill，包括用户目录下的和项目里的', { cli: name })}
                    </p>
                    <CliSkills key={id} cli={id} projectId={project!.id} />
                  </section>
                </>
              }
            />
          )
        })()
      )}
    </div>
  )
}
