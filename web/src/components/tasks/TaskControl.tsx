import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Loader2, Pause, Play } from 'lucide-react'
import type { Task } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/**
 * 任务的暂停 / 继续：执行中只能暂停，暂停（停止）或失败后只能继续，所以同一时间只给一个动作。
 * 暂停就是停止任务，继续时从没完成的节点接着跑（CLI 会话还在，会接着上次的上下文）。
 */
export function useTaskControl(task: Task) {
  const { upsertTask } = useData()
  const [busy, setBusy] = useState(false)
  // 暂停只在 CLI 真的处理这一轮时给；只是停在等下一句/预热时按空闲算
  const action: 'pause' | 'resume' | null = task.working
    ? 'pause'
    : task.status === 'stopped' || task.status === 'failed'
      ? 'resume'
      : null
  const run = async () => {
    if (!action || busy) return
    setBusy(true)
    try {
      upsertTask(action === 'pause' ? await api.stopTaskSummary(task.id) : await api.resumeTaskSummary(task.id))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { action, busy, run, label: action === 'pause' ? t('暂停') : t('继续') }
}

/** 列表行尾的小按钮：执行中显示暂停，暂停或失败后显示继续，完成的任务不显示 */
export function TaskControlButton({ task, className }: { task: Task; className?: string }) {
  const { action, busy, run, label } = useTaskControl(task)
  if (!action) return null
  const Icon = busy ? Loader2 : action === 'pause' ? Pause : Play
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        run()
      }}
      disabled={busy}
      title={action === 'pause' ? t('暂停任务，之后可以继续') : t('从没完成的地方继续执行')}
      aria-label={label}
      className={cn(
        'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg border px-2 text-xs text-muted transition-colors hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-60',
        className,
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', busy && 'animate-spin', !busy && action === 'resume' && 'text-accent')} />
      {label}
    </button>
  )
}
