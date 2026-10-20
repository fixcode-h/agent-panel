import { ChevronRight, CircleCheck, CircleX, Loader2, Workflow as WorkflowIcon, X } from 'lucide-react'
import type { Task } from '@shared/schema'
import { stepMs } from '@shared/task'
import { topSteps } from '@shared/flow'
import { useData } from '@/lib/data'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { fmtDuration } from '@/lib/tasks'
import { Button } from '@/components/ui/button'
import { StepIcon } from './TaskStatusIcon'
import { StepSection } from './StepSection'
import { t } from '@shared/i18n'

/** 一次运行的状态：有失败的算失败，还在跑的算执行中，全做完算完成 */
function runState(task: Task, run: number) {
  const steps = topSteps(task, run)
  if (steps.some((s) => s.status === 'failed')) return 'failed' as const
  if (steps.some((s) => s.status === 'running')) return 'running' as const
  if (steps.length && steps.every((s) => s.status === 'done' || s.status === 'skipped')) return 'done' as const
  return 'waiting' as const
}

/** 这次运行花的工夫：各个节点的执行时间相加 */
function runDuration(task: Task, run: number, now: number) {
  const ms = topSteps(task, run).reduce((n, s) => n + stepMs(s, now), 0)
  return ms >= 1000 ? fmtDuration(ms) : ''
}

/**
 * 主 Agent 对话流里代表一次工作流运行的卡片：节点输出不直接铺在对话里，
 * 点开在右边看这一次运行的实时输出
 */
export function RunCard({
  task,
  run,
  name,
  onOpen,
}: {
  task: Task
  run: number
  /** 工作流名字，显示在标题旁边 */
  name?: string
  onOpen: () => void
}) {
  const now = useNow(task.status === 'running')
  const steps = topSteps(task, run)
  const state = runState(task, run)
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const time = runDuration(task, run, now)
  const preview = steps
    .map((s) => s.title)
    .filter(Boolean)
    .slice(0, 4)
    .join(' · ')
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('查看这次运行的实时输出')}
      data-run={run}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-left shadow-card transition-colors hover:border-line-strong hover:bg-sel/40"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-field">
        {state === 'running' ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : state === 'done' ? (
          <CircleCheck className="h-4 w-4 text-success" />
        ) : state === 'failed' ? (
          <CircleX className="h-4 w-4 text-danger" />
        ) : (
          <WorkflowIcon className="h-4 w-4 text-muted" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-[0.8125rem] font-medium">
          <span className="truncate">{t('运行 {n}', { n: run })}</span>
          {name && <span className="truncate text-xs font-normal text-subtle">{name}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-subtle">
          {steps.length > 0 && (
            <span className="shrink-0 tabular-nums">{t('{done}/{total} 个节点', { done, total: steps.length })}</span>
          )}
          {preview && <span className="min-w-0 truncate">{preview}</span>}
        </span>
      </span>
      {time && <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">{time}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

/**
 * 右边打开的这一次运行：主流程每个节点的输出按顺序排下来，跟着任务实时更新。
 * 还没开始的节点也列出来，能看出这次运行还有哪些事
 */
export function RunDrawer({
  task,
  run,
  name,
  onClose,
}: {
  task: Task
  run: number
  name?: string
  onClose: () => void
}) {
  const { agents } = useData()
  const teamNames = new Set(agents.map((a) => a.name))
  const steps = topSteps(task, run)
  const state = runState(task, run)
  useEscape(true, onClose)
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30" onClick={onClose} aria-hidden />
      <aside
        aria-label={t('运行 {n}', { n: run })}
        className="fixed inset-y-0 right-0 z-40 flex w-[min(760px,100vw)] flex-col border-l bg-bg shadow-pop"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <WorkflowIcon className="h-4 w-4 shrink-0 text-muted" />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[0.875rem] font-medium">{t('运行 {n}', { n: run })}</span>
            {name && <span className="truncate text-xs text-subtle">{name}</span>}
            {state === 'running' && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-accent">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('执行中')}
              </span>
            )}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label={t('关闭')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-(--content-w) flex-col gap-7 px-4 py-5 md:px-6">
            {steps.map((s) => {
              const msgs = task.messages.filter(
                (m) => m.role !== 'user' && (m.step === s.id || m.step.startsWith(s.id + '/')),
              )
              if (!msgs.length && s.status === 'pending')
                return (
                  <div key={s.id} className="flex items-center gap-2 text-[0.8125rem] text-subtle">
                    <StepIcon status={s.status} />
                    <span className="min-w-0 truncate">{s.title}</span>
                    <span className="shrink-0 text-xs">{t('等待执行')}</span>
                  </div>
                )
              return (
                <StepSection key={s.id} task={task} rootId={s.id} msgs={msgs} teamNames={teamNames} sticky="flow" />
              )
            })}
            {!steps.length && <p className="text-[0.8125rem] text-subtle">{t('这次运行还没有节点。')}</p>}
          </div>
        </div>
      </aside>
    </>
  )
}
