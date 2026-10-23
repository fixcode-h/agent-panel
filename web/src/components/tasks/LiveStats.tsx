import { Zap } from 'lucide-react'
import type { Task } from '@shared/schema'
import { fmtTokens, tpsNow } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 执行中提示后面的实时数据：输出速度（token/s）和这次任务累计的 token */
export function LiveStats({ task, agentIds, className }: { task: Task; agentIds?: string[]; className?: string }) {
  // 节点没记录 Agent（交给主 Agent）时不知道是谁在输出，就看全部
  const tps = tpsNow(task, agentIds?.every(Boolean) ? agentIds : undefined)
  // 只显示正在输出的速度：没在输出（跑工具、思考、已经停下）时写「空闲」，不拿上一次的速度冒充实时
  return (
    <span className={cn('flex items-center gap-2 font-mono text-[0.6875rem] text-subtle tabular-nums', className)}>
      <span
        className={cn('flex items-center gap-1', tps > 0 ? 'text-accent' : 'text-subtle')}
        title={t('实时输出速度')}
      >
        <Zap className="h-3 w-3" />
        {tps > 0 ? `${tps.toFixed(1)} token/s` : t('空闲')}
      </span>
      <span
        title={t('输入 {input} · 输出 {output}', { input: task.usage.inputTokens, output: task.usage.outputTokens })}
      >
        ↑{fmtTokens(task.usage.inputTokens)} ↓{fmtTokens(task.usage.outputTokens)}
      </span>
    </span>
  )
}
