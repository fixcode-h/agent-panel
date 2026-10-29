import { subAgentIds } from '@shared/flow'
import { ArrowUpRight, Crown } from 'lucide-react'
import type { Workflow } from '@shared/schema'
import { t } from '@shared/i18n'
import { useData, useNav } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { StatusDot } from '@/components/ui/badge'
import { AgentAvatar } from '@/components/agents/AgentAvatar'

/** 侧栏里的工作流摘要：名称、团队、是否就绪，点击跳到工作流 */
export function WorkflowSummary({ workflow, source }: { workflow?: Workflow; source?: string }) {
  const { agents, clis, workflows } = useData()
  const { go } = useNav()
  if (!workflow)
    return (
      <section className="rounded-xl bg-card shadow-card p-4">
        <h3 className="mb-1 text-[0.8125rem] font-semibold">{t('工作流')}</h3>
        <p className="text-xs text-subtle">{t('还没有指定工作流。')}</p>
      </section>
    )
  const byId = new Map(agents.map((a) => [a.id, a]))
  const main = byId.get(workflow.mainAgentId)
  const subs = subAgentIds(workflow)
    .map((id) => byId.get(id))
    .filter(Boolean)
  return (
    <section className="rounded-xl bg-card shadow-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[0.8125rem] font-semibold">{t('工作流')}</h3>
        {source && <span className="text-xs text-subtle">{source}</span>}
      </div>
      <button
        onClick={() => go({ page: 'workflows', id: workflow.id })}
        className="mb-3 flex w-full cursor-pointer items-center gap-2 rounded-lg border bg-field px-3 py-2 text-left hover:border-line-strong"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[0.8125rem] font-medium">{workflow.name}</span>
          {isReady(workflowChecks(workflow, agents, clis, workflows)) ? (
            <StatusDot tone="success" label={t('就绪')} />
          ) : (
            <StatusDot tone="warning" label={t('未就绪，点开查看')} />
          )}
        </span>
        <ArrowUpRight className="h-4 w-4 text-subtle" />
      </button>
      {main && (
        <div className="flex items-center gap-2.5 rounded-lg bg-accent-soft p-2">
          <AgentAvatar icon={main.icon} cli={main.cli} size="sm" dim={!main.enabled} />
          <span className="flex-1 truncate text-[0.8125rem] font-medium">{main.name}</span>
          <Crown className="h-3.5 w-3.5 text-accent-text" />
        </div>
      )}
      {subs.length > 0 && (
        <div className="mt-1 ml-5 flex flex-col gap-0.5 border-l border-line-strong pt-1 pl-3">
          {subs.map((a) => (
            <div key={a!.id} className="flex items-center gap-2.5 px-2 py-1.5 text-[0.8125rem] text-muted">
              <AgentAvatar icon={a!.icon} cli={a!.cli} size="xs" dim={!a!.enabled} />
              <span className="truncate">{a!.name}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
