import { ArrowDown, ArrowUp, Crown, Plus, ArrowLeftRight, X } from 'lucide-react'
import type { Agent, WorkflowMember } from '@shared/schema'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentPicker } from '@/components/agents/AgentPicker'
import { cn } from '@/lib/utils'
import { useAgentView } from '@/lib/agent-view'

function AgentLine({ agent }: { agent: Agent }) {
  const { cliName, modelOf } = useAgentView()
  const { clis } = useData()
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

/** 工作流团队：一个主 Agent + 有序的子 Agent 列表，每个子 Agent 可写在本工作流中的职责 */
export function TeamEditor({
  mainAgentId,
  members,
  onMainChange,
  onMembersChange,
}: {
  mainAgentId: string
  members: WorkflowMember[]
  onMainChange: (id: string) => void
  onMembersChange: (m: WorkflowMember[]) => void
}) {
  const { agents } = useData()
  const byId = new Map(agents.map((a) => [a.id, a]))
  const main = byId.get(mainAgentId)
  const used = [mainAgentId, ...members.map((m) => m.agentId)]

  const move = (i: number, d: -1 | 1) => {
    const next = [...members]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    onMembersChange(next)
  }
  const update = (i: number, responsibility: string) =>
    onMembersChange(members.map((m, j) => (j === i ? { ...m, responsibility } : m)))

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Crown className="h-3.5 w-3.5 text-accent" />主 Agent
          <span className="text-subtle">· 按文档推进，把步骤分派给子 Agent，并验收结果</span>
        </span>
        {main ? (
          <div className="flex items-center gap-3 rounded-[10px] border border-accent/50 bg-accent-soft p-3">
            <AgentLine agent={main} />
            <AgentPicker exclude={used} onPick={(a) => onMainChange(a.id)} align="end">
              <Button variant="secondary" size="sm" className="ml-auto">
                <ArrowLeftRight className="h-3.5 w-3.5" />
                更换
              </Button>
            </AgentPicker>
          </div>
        ) : (
          <AgentPicker exclude={used} onPick={(a) => onMainChange(a.id)}>
            <button className="flex h-[62px] w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-accent/60 text-[13px] text-accent hover:bg-accent-soft">
              <Plus className="h-4 w-4" />
              选择主 Agent
            </button>
          </AgentPicker>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">
          子 Agent <span className="text-subtle">· 按执行顺序排列，可以写清楚它在这个工作流里负责什么</span>
        </span>
        <ol className="flex flex-col gap-2">
          {members.map((m, i) => {
            const a = byId.get(m.agentId)
            if (!a) return null
            return (
              <li key={m.agentId} className="flex flex-wrap items-center gap-3 rounded-[10px] border bg-card p-3">
                <span className="w-4 text-center font-mono text-xs text-subtle">{i + 1}</span>
                <span className="flex min-w-0 flex-[1_1_160px] items-center gap-3">
                  <AgentLine agent={a} />
                </span>
                <input
                  aria-label={`${a.name} 的职责`}
                  value={m.responsibility}
                  onChange={(e) => update(i, e.target.value)}
                  placeholder="在这个工作流中负责…"
                  className="h-9 min-w-0 flex-[2_1_220px] rounded-lg border border-line-strong bg-field px-3 text-[13px] outline-none placeholder:text-subtle focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
                />
                <span className="flex items-center">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="上移"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="下移"
                    disabled={i === members.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="移出团队"
                    className="hover:text-danger"
                    onClick={() => onMembersChange(members.filter((_, j) => j !== i))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </li>
            )
          })}
        </ol>
        <AgentPicker
          exclude={used}
          onPick={(a) => onMembersChange([...members, { agentId: a.id, responsibility: '' }])}
        >
          <button
            className={cn(
              'flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-strong text-[13px] text-muted hover:border-accent/60 hover:text-accent',
            )}
          >
            <Plus className="h-4 w-4" />
            添加子 Agent
          </button>
        </AgentPicker>
      </div>
    </>
  )
}
