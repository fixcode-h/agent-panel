import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusPill, type StatusTone } from './status-pill'

/** 节点的状态只分这几种：画法由这里定，调用方从 StepStatus 映射过来 */
export type FlowNodeState = 'done' | 'running' | 'failed' | 'idle'

export interface FlowNode {
  id: string
  label: string
  state: FlowNodeState
}

const TONE: Record<FlowNodeState, StatusTone> = { done: 'ok', running: 'run', failed: 'err', idle: 'idle' }

/**
 * 工作流节点条（组件库「计划 · 工作流 · FlowStrip」）：一个节点一个状态胶囊，节点之间一小段横线。
 * 完成绿、运行中强调色转圈、失败红、没开始灰；放不下就折到下一行，不横向滚动
 */
export function FlowStrip({ nodes, className }: { nodes: FlowNode[]; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-y-1.5', className)}>
      {nodes.map((n, i) => (
        <span key={n.id} className="flex min-w-0 items-center">
          {i > 0 && <span aria-hidden className="mx-1 h-px w-2 shrink-0 bg-line-strong" />}
          <StatusPill tone={TONE[n.state]} spin={n.state === 'running'} className="max-w-48 min-w-0">
            {n.state === 'done' && <Check className="h-3 w-3 shrink-0" strokeWidth={2.6} />}
            {n.state === 'failed' && <X className="h-3 w-3 shrink-0" strokeWidth={2.6} />}
            <span className="min-w-0 truncate">{n.label}</span>
          </StatusPill>
        </span>
      ))}
    </div>
  )
}
