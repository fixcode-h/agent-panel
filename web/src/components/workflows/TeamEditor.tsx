import { Crown, Plus, ArrowLeftRight } from 'lucide-react'
import type { Agent, NodeTier } from '@shared/schema'
import { MODEL_TIERS } from '@shared/clis'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentPicker } from '@/components/agents/AgentPicker'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { useAgentView } from '@/lib/agent-view'

function AgentLine({ agent }: { agent: Agent }) {
  const { cliName, modelOf } = useAgentView()
  return (
    <>
      <AgentAvatar icon={agent.icon} cli={agent.cli} dim={!agent.enabled} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{agent.name}</span>
        <span className="truncate font-mono text-xs text-muted">
          {cliName(agent)} · {modelOf(agent)}
        </span>
      </span>
    </>
  )
}

/**
 * 工作流的 Agent：只配主 Agent（调度整个流程、评估子 Agent 的结果、整理最终结果）；
 * 子 Agent 在流程节点上选，这里列出节点上用到了哪些
 */
export function TeamEditor({
  mainAgentId,
  onMainChange,
  team,
  dispatch,
  onDispatchChange,
  mainTier,
  onMainTierChange,
}: {
  mainAgentId: string
  onMainChange: (id: string) => void
  /** 节点上用到的子 Agent（只读） */
  team: { agent: Agent; responsibility: string }[]
  dispatch: boolean
  onDispatchChange: (v: boolean) => void
  mainTier: NodeTier
  onMainTierChange: (v: NodeTier) => void
}) {
  const { agents } = useData()
  const main = agents.find((a) => a.id === mainAgentId)
  const subs = team.filter((m) => m.agent.id !== mainAgentId)

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Crown className="h-3.5 w-3.5 text-accent" />
          {t('主 Agent')}
          <span className="text-subtle">· {t('调度流程：评估子 Agent 的结果、决定往哪走、最后整理结果')}</span>
        </span>
        {main ? (
          <div className="flex items-center gap-3 rounded-[10px] border border-accent/50 bg-accent-soft p-3">
            <AgentLine agent={main} />
            <AgentPicker exclude={[mainAgentId]} onPick={(a) => onMainChange(a.id)} align="end">
              <Button variant="secondary" size="sm" className="ml-auto">
                <ArrowLeftRight className="h-3.5 w-3.5" />
                {t('更换')}
              </Button>
            </AgentPicker>
          </div>
        ) : (
          <AgentPicker exclude={[]} onPick={(a) => onMainChange(a.id)}>
            <button className="flex h-[62px] w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-accent/60 text-[0.8125rem] text-accent hover:bg-accent-soft">
              <Plus className="h-4 w-4" />
              {t('选择主 Agent')}
            </button>
          </AgentPicker>
        )}
      </div>

      <div className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-3">
        <label className="flex cursor-pointer items-start gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[0.8125rem] font-medium">{t('主 Agent 调度')}</span>
            <span className="text-xs leading-relaxed text-subtle">
              {t(
                '子 Agent 做完的节点交给主 Agent 评估：通过、退回修改、委派给别的工作流或停下，条件分支也由它选，流程结束后它整理最终结果。关掉时按连线自动往下走，少花几轮。',
              )}
            </span>
          </span>
          <Switch checked={dispatch} onCheckedChange={onDispatchChange} aria-label={t('主 Agent 调度')} />
        </label>
        {dispatch && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">{t('调度用的模型档位')}</span>
            <Segmented
              label={t('调度用的模型档位')}
              value={mainTier}
              onChange={(v) => onMainTierChange(v)}
              options={[
                { id: '' as NodeTier, label: t('跟随 Agent') },
                ...MODEL_TIERS.map((m) => ({ id: m.id as NodeTier, label: t('{tier}档', { tier: m.label }) })),
              ]}
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">
          {t('子 Agent')}{' '}
          <span className="text-subtle">· {t('在流程图的节点上选；节点执行中还可以自己再派子 Agent 并发处理')}</span>
        </span>
        {subs.length ? (
          <ul className="flex flex-wrap gap-2">
            {subs.map((m) => (
              <li key={m.agent.id} className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5">
                <AgentAvatar icon={m.agent.icon} cli={m.agent.cli} size="xs" dim={!m.agent.enabled} />
                <span className="text-[0.8125rem]">{m.agent.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-subtle">{t('节点还都由主 Agent 自己做。')}</p>
        )}
      </div>
    </>
  )
}
