import { Copy, Crown, Pencil, Quote, Trash2 } from 'lucide-react'
import type { Agent, CliStatus } from '@shared/schema'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { CommandPreview } from './CommandPreview'

export interface AgentActions {
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onSetMain: () => void
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="mt-1 truncate text-[13px] font-medium">{children}</div>
    </div>
  )
}

export function MainAgentCard({ agent, cli, onEdit, onDuplicate, onDelete }: { agent: Agent; cli?: CliStatus } & AgentActions) {
  return (
    <div className="gradient-border animate-rise relative overflow-hidden rounded-[18px] bg-surface shadow-card">
      <div className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-accent/20 blur-3xl" />
      <div className="relative grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <div className="flex items-start gap-4">
            <AgentAvatar icon={agent.icon} cli={agent.cli} size="lg" dim={!agent.enabled} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-[18px] font-semibold tracking-tight">{agent.name}</h3>
                <Badge tone="accent">
                  <Crown className="h-3 w-3" />
                  主 Agent
                </Badge>
                {!agent.enabled && <Badge tone="warning">已停用</Badge>}
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted">
                {agent.description || '还没有简介'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">编辑</span>
              </Button>
              <Button variant="ghost" size="icon" title="复制" className="hidden sm:inline-flex" onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" title="删除" className="hover:text-danger" onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-4 rounded-xl border bg-bg/40 px-4 py-3">
            <Meta label="CLI">
              <span className="inline-flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 rounded-full', cliStyle(agent.cli).dot)} />
                {cli?.name ?? agent.cli}
              </span>
            </Meta>
            <Meta label="模型">
              <span className="font-mono text-[12px]">{agent.model || '默认'}</span>
            </Meta>
            <Meta label="状态">
              {cli && !cli.installed ? (
                <span className="text-warning">CLI 未安装</span>
              ) : agent.enabled ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_8px_var(--success)]" />
                  就绪
                </span>
              ) : (
                <span className="text-subtle">已停用</span>
              )}
            </Meta>
          </div>

          {agent.instructions && (
            <div className="mt-4 flex gap-2.5 text-[13px] leading-relaxed text-muted">
              <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
              <p className="line-clamp-2">{agent.instructions}</p>
            </div>
          )}
        </div>

        <CommandPreview cli={agent.cli} model={agent.model} extraArgs={agent.extraArgs} className="self-start" />
      </div>
    </div>
  )
}
