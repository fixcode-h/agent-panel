import type { Agent, Project, ProjectInput } from '@shared/schema'
import { t } from '@shared/i18n'
import { paramsForVcs } from '@shared/doc-root'
import { CORE_AGENTS, coreKey, coreUse, findCore, isHelperAgent } from '@shared/builtin/core'
import { useData, useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { ParamsForm } from '@/components/agents/ParamFields'
import { DocRootHint } from '../DocRootHint'
import { Collapsible, PageIntro } from './parts'
import type { SetDraft, Vcs } from './project-draft'

/**
 * 项目设置 →「必备角色」：协调器、执行、文档、测试、版本控制这几个角色在这个项目里的参数。
 * 从 ProjectSettingsDialog.tsx 挪出；只读写草稿里的 agentParams。
 */
export function RolesPage({
  project,
  draft,
  setDraft,
  vcs,
}: {
  project?: Project
  draft: ProjectInput
  setDraft: SetDraft
  vcs: Vcs
}) {
  const { agents } = useData()
  const { go } = useNav()
  // 「子任务」不作为可选角色展示，也没有参数：跳去角色页的那个按钮只会跳开，不在这个列表里列；Chat 页的「助手」不是项目里的角色
  const coreAgents = CORE_AGENTS.map((c) => findCore(agents, c.key)).filter(
    (a): a is Agent => !!a && !isHelperAgent(a) && a.scope !== 'chat',
  )
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('必备角色')}
        desc={t(
          '项目对话靠这几个角色运转：协调器分诊、执行做事、文档落盘、测试验收、版本控制收尾。角色本身不能换，这里改的参数只对这个项目生效，没改的跟随角色页里的默认值。',
        )}
      />
      {coreAgents.map((a) => (
        <Collapsible
          key={a.id}
          defaultOpen={coreAgents.indexOf(a) === 0}
          leading={<AgentAvatar icon={a.icon} cli={a.cli} size="sm" />}
          title={a.name}
          subtitle={coreUse(coreKey(a)!)}
          badge={
            Object.keys(draft.agentParams[a.id] ?? {}).length
              ? t('改了 {n} 项', { n: Object.keys(draft.agentParams[a.id] ?? {}).length })
              : undefined
          }
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => go({ page: 'agents', id: a.id })}
              title={t('去角色页改所有项目的默认值和模型')}
            >
              {t('角色设置')}
            </Button>
          }
        >
          {paramsForVcs(a.params, vcs).length ? (
            <ParamsForm
              // 「文档根」下拉只在 P4 项目里显示（见 shared/doc-root.ts）
              params={paramsForVcs(a.params, vcs)}
              values={draft.agentParams[a.id] ?? {}}
              onChange={(v) =>
                setDraft((d) => {
                  const next = { ...d.agentParams }
                  if (Object.keys(v).length) next[a.id] = v
                  else delete next[a.id]
                  return { ...d, agentParams: next }
                })
              }
            />
          ) : (
            <p className="text-xs text-subtle">{t('这个角色没有可调的参数。')}</p>
          )}
          {coreKey(a) === 'docsync' && (
            <DocRootHint
              projectId={project?.id ?? ''}
              path={draft.path}
              vcs={vcs}
              agent={a}
              values={draft.agentParams[a.id] ?? {}}
            />
          )}
        </Collapsible>
      ))}
      {!coreAgents.length && <p className="text-xs text-subtle">{t('必备角色还没装好，重启面板后会自动补上。')}</p>}
    </div>
  )
}
