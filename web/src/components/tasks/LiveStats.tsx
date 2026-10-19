import { Zap } from 'lucide-react'
import type { Task } from '@shared/schema'
import { fmtTokens, liveTps } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 执行中提示后面的实时数据：输出速度（token/s）和这次任务累计的 token */
export function LiveStats({ task, agentIds, className }: { task: Task; agentIds?: string[]; className?: string }) {
  // 节点没记录 Agent（交给主 Agent）时不知道是谁在输出，就看全部
  const tps = liveTps(task, agentIds?.every(Boolean) ? agentIds : undefined)
  const total = task.usage.inputTokens + task.usage.outputTokens
  if (!tps && !total) return null
  return (
    <span className={cn('flex items-center gap-2 font-mono text-[0.6875rem] text-subtle tabular-nums', className)}>
      {tps > 0 && (
        <span className="flex items-center gap-1 text-accent" title={t('实时输出速度')}>
          <Zap className="h-3 w-3" />
          {tps.toFixed(1)} token/s
        </span>
      )}
      {total > 0 && (
        <span
          title={t('输入 {input} · 输出 {output}', { input: task.usage.inputTokens, output: task.usage.outputTokens })}
        >
          ↑{fmtTokens(task.usage.inputTokens)} ↓{fmtTokens(task.usage.outputTokens)}
        </span>
      )}
    </span>
  )
}
