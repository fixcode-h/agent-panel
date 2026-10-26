import { Zap } from 'lucide-react'
import type { Task } from '@shared/schema'
import { fmtTokens, tpsNow } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 执行中提示后面的实时数据：输出速度（token/s）和这次任务累计的 token */
export function LiveStats({
  task,
  agentIds,
  waiting,
  className,
}: {
  task: Task
  agentIds?: string[]
  /** 这一轮没在跑、也没在出 token，但对话还在等别人的结果（子任务、后台命令、工作流）：
   *  这时写「空闲」会让人以为它没事可做（用户报的：子任务在跑、状态行说空闲） */
  waiting?: boolean
  className?: string
}) {
  // 节点没记录 Agent（交给主 Agent）时不知道是谁在输出，就看全部
  const tps = tpsNow(task, agentIds?.every(Boolean) ? agentIds : undefined)
  // 只显示正在输出的速度：没在输出（跑工具、思考、还在等结果）时写「等待中 / 空闲」，
  // 不拿上一次的速度冒充实时
  return (
    <span className={cn('flex items-center gap-2 font-mono text-[0.6875rem] text-subtle tabular-nums', className)}>
      <span
        className={cn('flex items-center gap-1', tps > 0 ? 'text-accent' : 'text-subtle')}
        title={t('实时输出速度')}
      >
        <Zap className="h-3 w-3" />
        {tps > 0 ? `${tps.toFixed(1)} token/s` : waiting ? t('等待中') : t('空闲')}
      </span>
      <span
        title={t('输入 {input} · 输出 {output}', { input: task.usage.inputTokens, output: task.usage.outputTokens })}
      >
        ↑{fmtTokens(task.usage.inputTokens)} ↓{fmtTokens(task.usage.outputTokens)}
      </span>
    </span>
  )
}
