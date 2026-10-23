import {
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Loader2,
  MessageCircleQuestion,
  MessageSquare,
  PauseCircle,
} from 'lucide-react'
import type { StepStatus, TaskStatus } from '@shared/schema'
import { statusLabel } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/**
 * 任务状态图标。
 * - working 是 CLI 正在处理这一轮：进程活着但在等下一句/预热时不算执行中
 * - spin 用在子对话上：还没彻底完成（计划没做完、独立分支没合回）时也要转圈，见 childSpinning
 * - waiting 用在子对话上：有提问/待确认在等你时换成提问图标，转圈会把「等你选」说成「还在跑」
 */
export function TaskStatusIcon({
  status,
  working = true,
  spin,
  waiting,
  className,
}: {
  status: TaskStatus
  working?: boolean
  spin?: boolean
  waiting?: boolean
  className?: string
}) {
  const c = cn('h-4 w-4 shrink-0', className)
  const label = statusLabel[status]
  if (waiting && status !== 'failed')
    return <MessageCircleQuestion className={cn(c, 'text-warning')} aria-label={t('等你选择')} />
  if (spin ?? (status === 'running' && working))
    return <Loader2 className={cn(c, 'animate-spin text-accent')} aria-label={label} />
  if (status === 'running' && !working)
    return <MessageSquare className={cn(c, 'text-subtle')} aria-label={t('等待你的下一条消息')} />
  if (status === 'done') return <CircleCheck className={cn(c, 'text-success')} aria-label={label} />
  if (status === 'failed') return <CircleX className={cn(c, 'text-danger')} aria-label={label} />
  return <PauseCircle className={cn(c, 'text-subtle')} aria-label={label} />
}

const STEP_LABEL: Record<StepStatus, string> = {
  pending: t('等待'),
  running: t('执行中'),
  done: t('完成'),
  failed: t('失败'),
  skipped: t('跳过'),
}

/** 节点状态图标：等待中是空心圆 */
export function StepIcon({ status, className }: { status: StepStatus; className?: string }) {
  const c = cn('h-4 w-4 shrink-0', className)
  const label = STEP_LABEL[status]
  if (status === 'running') return <Loader2 className={cn(c, 'animate-spin text-accent')} aria-label={label} />
  if (status === 'done') return <CircleCheck className={cn(c, 'text-success')} aria-label={label} />
  if (status === 'failed') return <CircleX className={cn(c, 'text-danger')} aria-label={label} />
  if (status === 'skipped') return <CircleSlash className={cn(c, 'text-subtle')} aria-label={label} />
  return <Circle className={cn(c, 'text-line-strong')} aria-label={label} />
}
