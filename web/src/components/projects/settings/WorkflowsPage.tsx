import { Plus, Sparkles, Workflow as WorkflowIcon, X } from 'lucide-react'
import type { ParamValue, ProjectInput, Workflow } from '@shared/schema'
import { derivedParams, agentParamGroups } from '@shared/agents/params'
import { exposesForVcs } from '@shared/doc-root'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Select } from '@/components/ui/input'
import { HelpTip } from '@/components/ui/help-tip'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { AgentParamsEditor, ExposeField } from './workflow-params'
import { Collapsible, PageIntro } from './parts'
import type { AiSession, SetDraft, SetField, Vcs } from './project-draft'

/** 默认工作流从这个工作流分类里选（内置的「通用项目」「UE 项目」都在这里） */
const PROJECT_WF_CATEGORY = '项目'

/**
 * 项目设置 →「工作流」：默认工作流、可选工作流和每个工作流的配置。
 * 从 ProjectSettingsDialog.tsx 挪出；只读写草稿里的 workflowId、workflowIds 和 workflowParams。
 */
export function WorkflowsPage({
  draft,
  setDraft,
  set,
  vcs,
  own,
  inherited,
  general,
  active,
  onAssist,
}: {
  draft: ProjectInput
  setDraft: SetDraft
  set: SetField
  vcs: Vcs
  /** 单独指定的默认工作流 */
  own?: Workflow
  /** 跟随分类的默认工作流 */
  inherited?: Workflow
  /** 都没有时落到的「通用项目」 */
  general?: Workflow
  /** 实际会用的那个 */
  active?: Workflow
  onAssist: (s: AiSession) => void
}) {
  const { workflows, agents, categories } = useData()
  // 每个工作流一份配置：默认工作流和每个可选工作流各自保存
  const paramsOf = (id: string) => draft.workflowParams[id] ?? {}
  const setParam = (id: string, key: string, value: ParamValue) =>
    setDraft((d) => ({
      ...d,
      workflowParams: { ...d.workflowParams, [id]: { ...(d.workflowParams[id] ?? {}), [key]: value } },
    }))
  const optionalWorkflows = draft.workflowIds
    .map((id) => workflows.find((w) => w.id === id))
    .filter((w): w is (typeof workflows)[number] => !!w)
  // 工作流 expose 里 target=agent 的 key 由 expose 表单管，这里不重复渲染（同一个参数只有一处配置源）
  const paramsFor = (w: (typeof workflows)[number]) => {
    const derived = derivedParams(w, agents)
    const exposed = new Set(w.expose.filter((e) => e.target === 'agent').map((e) => e.targetId))
    return { derived, exposed, groups: agentParamGroups(w, agents) }
  }
  // 默认工作流只从「项目」分类里选：项目常驻流程按子对话的需要设计，别的流程放进可选工作流
  const projectCat = categories.find((c) => c.scope === 'workflow' && c.name === PROJECT_WF_CATEGORY)
  const inProjectCat = workflows.filter((w) => projectCat && w.categoryId === projectCat.id)
  const defaultChoices = (inProjectCat.length ? inProjectCat : workflows).filter((w, i, list) => list.indexOf(w) === i)
  if (own && !defaultChoices.includes(own)) defaultChoices.unshift(own)
  const addable = workflows.filter((w) => w.id !== active?.id && !draft.workflowIds.includes(w.id))
  const hasAgentParams = (w: (typeof workflows)[number]) => {
    const { derived, groups } = paramsFor(w)
    return groups.some((g) => derived.some((d) => d.agents.some((a) => a.id === g.agentId)))
  }
  // AI 配置：一次只开一个，结果只填草稿；用户取消不会改数据
  // （会话本身由外壳拿着，见 AiSession：关掉设置时这里会卸载，对话不跟着停）
  const aiParams = (w: (typeof workflows)[number], agentId?: string, name?: string) =>
    onAssist({
      kind: 'params',
      workflowId: w.id,
      agentId,
      title: name ? t('AI 配置「{name}」', { name }) : t('AI 配置「{name}」的参数', { name: w.name }),
      start: t('读一下这个项目的目录、脚本和配置，按项目的实际情况把「{name}」的参数配好，说明每一项为什么这么填', {
        name: name ?? w.name,
      }),
    })
  // 一个工作流的配置：暴露项 + 它用到的角色的参数（按角色分组）
  const workflowParamsBody = (w: (typeof workflows)[number]) => {
    const { derived, exposed, groups } = paramsFor(w)
    // 「文档根」只在 P4 项目里显示（见 shared/doc-root.ts 的 exposesForVcs）
    const shown = exposesForVcs(w.expose, vcs)
    if (!shown.length && !hasAgentParams(w)) return null
    return (
      <div className="flex flex-col gap-3">
        {shown.map((e) => (
          <ExposeField
            key={e.key}
            e={e}
            value={paramsOf(w.id)[e.key] as ParamValue | undefined}
            onChange={(v) => setParam(w.id, e.key, v)}
          />
        ))}
        {groups.map((g) => (
          <AgentParamsEditor
            key={g.agentId}
            group={g}
            agents={derived}
            hidden={exposed}
            values={paramsOf(w.id)}
            onChange={(k, v) => setParam(w.id, k, v)}
            aiRunning={false}
            onAi={() => aiParams(w, g.agentId, g.agentName)}
          />
        ))}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('工作流')}
        desc={t(
          '子对话要改代码时按工作流执行：默认用下面这一个，需求更适合某个可选工作流时，执行角色会改用它。每个工作流的配置分开保存，对新开的对话生效。',
        )}
      />
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1 text-xs text-muted">
          {t('默认工作流')}
          <HelpTip>
            {t('只能从「{cat}」分类里选：这类工作流是为项目常驻流程设计的。', { cat: PROJECT_WF_CATEGORY })}
          </HelpTip>
        </span>
        <Select
          aria-label={t('默认工作流')}
          value={draft.workflowId}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              workflowId: e.target.value,
              workflowIds: d.workflowIds.filter((x) => x !== e.target.value),
            }))
          }
          options={[
            ...(!draft.workflowId
              ? [
                  {
                    value: '',
                    label: inherited
                      ? t('跟随分类：{name}', { name: inherited.name })
                      : general
                        ? t('未选择，将使用「{name}」', { name: general.name })
                        : t('请选择工作流'),
                  },
                ]
              : []),
            ...defaultChoices.map((w) => ({ value: w.id, label: w.name })),
          ]}
        />
      </div>
      {active && (
        <WorkflowCard
          key={active.id}
          w={active}
          isDefault
          defaultOpen
          body={workflowParamsBody(active)}
          onAi={hasAgentParams(active) ? () => aiParams(active) : undefined}
        />
      )}
      <div className="flex items-center gap-2 pt-2">
        <span className="text-xs text-muted">{t('可选工作流')}</span>
        <span className="text-xs text-subtle">{t('{n} 个', { n: optionalWorkflows.length })}</span>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="secondary" className="ml-auto" disabled={!addable.length}>
              <Plus className="h-3.5 w-3.5" />
              {t('添加可选工作流')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[320px]">
            <div className="max-h-72 overflow-y-auto">
              {addable.map((w) => (
                <PopoverClose
                  key={w.id}
                  className={menuItem}
                  onClick={() => set('workflowIds', [...draft.workflowIds, w.id])}
                >
                  <WorkflowIcon className="h-4 w-4 shrink-0 text-subtle" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{w.name}</span>
                    {w.description && <span className="truncate text-caption text-subtle">{w.description}</span>}
                  </span>
                </PopoverClose>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {optionalWorkflows.length === 0 && (
        <EmptyPanel size="sm" className="text-xs">
          {t('还没有可选工作流。像 Bug 修复、发布这类流程可以加进来，需求合适时执行角色会自动选它。')}
        </EmptyPanel>
      )}
      {optionalWorkflows.map((w) => (
        <WorkflowCard
          key={w.id}
          w={w}
          body={workflowParamsBody(w)}
          onAi={hasAgentParams(w) ? () => aiParams(w) : undefined}
          onRemove={() =>
            set(
              'workflowIds',
              draft.workflowIds.filter((x) => x !== w.id),
            )
          }
        />
      ))}
    </div>
  )
}

/** 一个工作流的卡片：默认的标「默认」，可选的能移除；有参数时点开配置 */
function WorkflowCard({
  w,
  isDefault,
  defaultOpen,
  body,
  onAi,
  onRemove,
}: {
  w: Workflow
  isDefault?: boolean
  defaultOpen?: boolean
  body: React.ReactNode
  onAi?: () => void
  onRemove?: () => void
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      leading={<WorkflowIcon className="h-4 w-4 shrink-0 text-subtle" />}
      title={w.name}
      subtitle={w.description || undefined}
      badge={isDefault ? t('默认') : undefined}
      actions={
        <>
          {onAi && (
            <Button size="sm" variant="ghost" onClick={onAi}>
              <Sparkles className="h-3.5 w-3.5" />
              {t('AI 配置')}
            </Button>
          )}
          {onRemove && <IconButton icon={X} size="sm" label={t('移除')} onClick={onRemove} />}
        </>
      }
    >
      {body ?? <p className="text-xs text-subtle">{t('这个工作流没有需要配置的参数。')}</p>}
    </Collapsible>
  )
}
