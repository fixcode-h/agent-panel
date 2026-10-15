import { Copy, Crown, Pencil, Trash2 } from 'lucide-react'
import type { Agent, CliStatus } from '@shared/schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './AgentAvatar'
import type { AgentActions } from './MainAgentCard'

export function SubAgentRow({
  agent,
  cli,
  onEdit,
  onDuplicate,
  onDelete,
  onSetMain,
}: { agent: Agent; cli?: CliStatus } & AgentActions) {
  return (
    <div
      onDoubleClick={onEdit}
      className={cn(
        'group relative flex items-center gap-4 rounded-[14px] border bg-surface px-4 py-3.5 shadow-card transition-all',
        'hover:border-border-strong hover:bg-elevated',
      )}
    >
      <AgentAvatar icon={agent.icon} cli={agent.cli} size="md" dim={!agent.enabled} />
      <div className={cn('min-w-0 flex-1', !agent.enabled && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold">{agent.name}</span>
          {!agent.enabled && <Badge tone="warning">已停用</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-muted">{agent.description || '还没有简介'}</p>
      </div>

      <div className={cn('hidden items-center gap-2 sm:flex', !agent.enabled && 'opacity-60')}>
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full border bg-bg/50 px-2.5 text-[11.5px]">
          <span className={cn('h-1.5 w-1.5 rounded-full', cliStyle(agent.cli).dot)} />
          {cli?.name ?? agent.cli}
          {cli && !cli.installed && <span className="text-warning">未安装</span>}
        </span>
        <span className="inline-flex h-6 min-w-20 items-center justify-center rounded-full border bg-bg/50 px-2.5 font-mono text-[11px] text-muted">
          {agent.model || '默认模型'}
        </span>
      </div>

      <div className="flex items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <Button variant="ghost" size="icon" title="设为主 Agent" className="hidden sm:inline-flex" onClick={onSetMain}>
          <Crown className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" title="编辑" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" title="复制" className="hidden sm:inline-flex" onClick={onDuplicate}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" title="删除" className="hover:text-danger" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
