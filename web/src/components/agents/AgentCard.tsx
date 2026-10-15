import { Copy, Crown, Pencil, Trash2 } from 'lucide-react'
import type { Agent, CliStatus } from '@shared/schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './AgentAvatar'

interface Props {
  agent: Agent
  cli?: CliStatus
  featured?: boolean
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onSetMain: () => void
}

export function AgentCard({ agent, cli, featured, onEdit, onDuplicate, onDelete, onSetMain }: Props) {
  const isMain = agent.role === 'main'
  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-2xl border bg-surface p-5 transition-all',
        'hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/30',
        isMain && 'border-accent/40 bg-gradient-to-br from-accent-soft via-surface to-surface',
        !agent.enabled && 'opacity-55',
      )}
    >
      {isMain && (
        <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-accent/20" />
      )}
      <div className="flex items-start gap-4">
        <AgentAvatar name={agent.name} cli={agent.cli} size={featured ? 'lg' : 'md'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cn('truncate font-semibold', featured ? 'text-lg' : 'text-[15px]')}>{agent.name}</h3>
            {isMain ? (
              <Badge tone="accent">
                <Crown className="h-3 w-3" />
                主 Agent
              </Badge>
            ) : (
              <Badge>子 Agent</Badge>
            )}
            {!agent.enabled && <Badge tone="warning">已停用</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted">
            {agent.description || <span className="italic opacity-70">暂无描述</span>}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-md border bg-surface-2 px-2 py-1">
          <span className={cn('h-1.5 w-1.5 rounded-full', cliStyle(agent.cli).dot)} />
          {cli?.name ?? agent.cli}
          {cli && !cli.installed && <span className="text-warning">· 未检测到</span>}
        </span>
        <span className="rounded-md border bg-surface-2 px-2 py-1 font-mono text-[11px] text-muted">
          {agent.model || '默认模型'}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-1 border-t pt-3">
        {!isMain && (
          <Button variant="ghost" size="sm" onClick={onSetMain}>
            <Crown className="h-3.5 w-3.5" />
            设为主 Agent
          </Button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon" title="编辑" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" title="复制" onClick={onDuplicate}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" title="删除" className="hover:text-danger" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
