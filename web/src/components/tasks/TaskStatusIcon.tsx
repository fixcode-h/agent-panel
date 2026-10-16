import { CircleCheck, CircleX, Loader2, PauseCircle } from 'lucide-react'
import type { TaskStatus } from '@shared/schema'
import { statusLabel } from '@/lib/tasks'
import { cn } from '@/lib/utils'

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const c = cn('h-4 w-4 shrink-0', className)
  const label = statusLabel[status]
  if (status === 'running') return <Loader2 className={cn(c, 'animate-spin text-accent')} aria-label={label} />
  if (status === 'done') return <CircleCheck className={cn(c, 'text-success')} aria-label={label} />
  if (status === 'failed') return <CircleX className={cn(c, 'text-danger')} aria-label={label} />
  return <PauseCircle className={cn(c, 'text-subtle')} aria-label={label} />
}
