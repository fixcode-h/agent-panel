import { Crown, Plus, ArrowLeftRight } from 'lucide-react'
import type { Agent, NodeTier } from '@shared/schema'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentPicker } from '@/components/agents/AgentPicker'
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
 * 工作流的 Agent：配一个默认执行 Agent（节点没单独指定时用它）；
 * 子 Agent 在流程节点上选，这里列出节点上用到了哪些
 */
export function TeamEditor({
  mainAgentId,
  onMainChange,
  team,
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
          {t('默认执行角色')}
          <span className="text-subtle">· {t('节点没有单独指定角色时用它；节点按连线并发执行，不再由它调度')}</span>
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
              {t('选择默认执行角色')}
            </button>
          </AgentPicker>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">
          {t('子角色')}{' '}
          <span className="text-subtle">· {t('在流程图的节点上选；节点执行中还可以自己再派子角色并发处理')}</span>
        </span>
        {subs.length ? (
          <ul className="flex flex-wrap gap-2">
            {subs.map((m) => (
              <li key={m.agent.id} className="flex items-center gap-2 rounded-lg bg-card shadow-card px-2.5 py-1.5">
                <AgentAvatar icon={m.agent.icon} cli={m.agent.cli} size="xs" dim={!m.agent.enabled} />
                <span className="text-[0.8125rem]">{m.agent.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-subtle">{t('节点还都由默认执行角色自己做。')}</p>
        )}
      </div>
    </>
  )
}
