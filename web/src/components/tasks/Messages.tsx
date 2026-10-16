import { useMemo } from 'react'
import { FileText, PencilLine, Search, Terminal, Wrench } from 'lucide-react'
import type { TaskMessage, ToolUse } from '@shared/schema'
import { useData } from '@/lib/data'
import { renderDoc } from '@/lib/workflow-doc'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { useAgentView } from '@/lib/agent-view'

export const toolIcon = {
  read: FileText,
  edit: PencilLine,
  run: Terminal,
  search: Search,
  other: Wrench,
}

export function ToolRow({ tool }: { tool: ToolUse }) {
  const Icon = toolIcon[tool.kind]
  const diff = tool.kind === 'edit' ? tool.detail.match(/^(\+\d+)?\s*(-\d+)?$/) : null
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-field px-2.5 py-1.5 font-mono text-xs text-muted">
      <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
      <span className="min-w-0 flex-1 truncate">{tool.label}</span>
      {diff ? (
        <span className="shrink-0">
          {diff[1] && <span className="text-success">{diff[1]}</span>}{' '}
          {diff[2] && <span className="text-danger">{diff[2]}</span>}
        </span>
      ) : (
        tool.detail && <span className="shrink-0 text-subtle">{tool.detail}</span>
      )}
    </div>
  )
}

export function AgentMessage({ m, teamNames, compact }: { m: TaskMessage; teamNames: Set<string>; compact?: boolean }) {
  const { modelOf } = useAgentView()
  const { agents } = useData()
  const a = agents.find((x) => x.id === m.agentId)
  const html = useMemo(() => renderDoc(m.text, teamNames), [m.text, teamNames])
  return (
    <div className="flex gap-3">
      {compact ? (
        <span className="w-[26px] shrink-0" />
      ) : a ? (
        <AgentAvatar icon={a.icon} cli={a.cli} size="sm" />
      ) : (
        <span className="h-[26px] w-[26px] shrink-0 rounded-[7px] bg-field" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {!compact && (
          <div className="flex items-center gap-2 pt-0.5 text-[13px]">
            <span className="font-medium">{a?.name ?? '已删除的 Agent'}</span>
            {a && <span className="font-mono text-xs text-subtle">{modelOf(a)}</span>}
          </div>
        )}
        {m.tools.length > 0 && (
          <div className="flex flex-col gap-1">
            {m.tools.map((t, i) => (
              <ToolRow key={i} tool={t} />
            ))}
          </div>
        )}
        {m.text && <div className="chat-md [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  )
}
