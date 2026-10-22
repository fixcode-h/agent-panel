import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Circle, CircleCheck, Hourglass, ListChecks, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PlanItem, PlanStatus, PlanStep, Task, TaskPlan } from '@shared/schema'
import { planChildren, planProgress, shownPlan } from '@shared/plan'
import { fmtDuration } from '@/lib/tasks'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'

const STATUS_LABEL: Record<PlanStatus, string> = {
  pending: t('待做'),
  running: t('进行中'),
  waiting: t('等待中'),
  done: t('完成'),
}

/** 计划步骤的状态图标：待做空心圆、进行中转圈、等待中沙漏、完成绿勾 */
function PlanIcon({ status, small }: { status: PlanStatus; small?: boolean }) {
  const c = cn('shrink-0', small ? 'h-3.5 w-3.5' : 'h-4 w-4')
  const label = STATUS_LABEL[status]
  if (status === 'running') return <Loader2 className={cn(c, 'animate-spin text-accent')} aria-label={label} />
  if (status === 'waiting') return <Hourglass className={cn(c, 'text-warning')} aria-label={label} />
  if (status === 'done') return <CircleCheck className={cn(c, 'text-success')} aria-label={label} />
  return <Circle className={cn(c, 'text-line-strong')} aria-label={label} />
}

/** 步骤后面的一小段：等待中写在等什么，完成写用了多久，进行中写做了多久 */
function itemMeta(x: PlanItem, now: number) {
  const waits = x.waits.filter((w) => w.state === 'waiting').map((w) => w.label || w.ref)
  if (x.status === 'waiting' && waits.length) return t('等：{what}', { what: waits.join(t('、')) })
  const from = Date.parse(x.startedAt)
  if (!Number.isFinite(from)) return ''
  if (x.status === 'done') {
    const end = Date.parse(x.endedAt)
    return Number.isFinite(end) && end > from ? fmtDuration(end - from) : ''
  }
  return x.status === 'running' ? fmtDuration(now - from) : ''
}

/**
 * 输入框上方的计划按钮：「计划 2/5 · 正在做的那一步」，点开是实时更新的计划窗口。
 * 只有对话列过计划才显示
 */
export function PlanButton({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscape(open, () => setOpen(false))
  // 点外面关：和子对话窗口一样
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const plan = shownPlan(task)
  if (!plan) return null
  const p = planProgress(task, plan)
  const finished = !!plan.doneAt
  const current = p.current?.child?.title ?? p.current?.step.title
  return (
    <div ref={ref} className="relative flex min-w-0 shrink items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('执行计划')}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-[0.8125rem] text-muted transition-colors hover:bg-sel hover:text-fg',
          open && 'bg-sel text-fg',
        )}
      >
        {finished ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : (
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-subtle" />
        )}
        <span className="shrink-0 font-medium">
          {finished ? t('计划已完成') : t('计划 {done}/{total}', { done: p.done, total: p.total })}
        </span>
        {!finished && current && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-subtle">
            <span>·</span>
            <span className="min-w-0 truncate">{current}</span>
          </span>
        )}
        {!finished && p.waiting > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-warning">
            <Hourglass className="h-3 w-3" />
            {t('{n} 个在等待', { n: p.waiting })}
          </span>
        )}
        {finished && !plan.summary && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-subtle">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('正在写总结')}
          </span>
        )}
      </button>
      {open && <PlanWindow task={task} plan={plan} />}
    </div>
  )
}

/** 计划窗口：当前计划的步骤（进行中的展开子步骤），做完的计划带总结；下面能翻以前的计划 */
function PlanWindow({ task, plan }: { task: Task; plan: TaskPlan }) {
  const p = planProgress(task, plan)
  const live = !plan.doneAt
  const now = useNow(live)
  const older = task.plans.slice(0, -1).reverse()
  const [history, setHistory] = useState(false)
  const teamNames = new Set<string>()
  return (
    <div
      role="dialog"
      aria-label={t('执行计划')}
      className="absolute bottom-full left-0 z-30 mb-1 flex max-h-[min(64vh,560px)] w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line-strong bg-card shadow-pop"
    >
      <div className="shrink-0 border-b px-3.5 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 shrink-0 text-subtle" />
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium" title={plan.title}>
            {plan.title || t('执行计划')}
          </span>
          <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">
            {p.done}/{p.total}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-field">
          <div
            className={cn('h-full rounded-full transition-[width] duration-500', live ? 'bg-accent' : 'bg-success')}
            style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <ol className="flex flex-col">
          {plan.steps.map((s) => (
            <PlanStepRow key={s.id} task={task} step={s} now={now} />
          ))}
        </ol>
        {plan.doneAt && <PlanSummary plan={plan} teamNames={teamNames} />}
        {older.length > 0 && (
          <div className="mt-1.5 border-t px-1 pt-1.5">
            <button
              type="button"
              aria-expanded={history}
              onClick={() => setHistory((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-subtle hover:bg-sel hover:text-fg"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', history && 'rotate-90')} />
              {t('以前的计划 · {n}', { n: older.length })}
            </button>
            {history && (
              <ul className="mt-0.5 flex flex-col">
                {older.map((x) => (
                  <OldPlan key={x.id} plan={x} teamNames={teamNames} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 一个主步骤：进行中、等待中的默认展开子步骤，做完立即收起；点一下可以手动展开收起 */
function PlanStepRow({ task, step, now }: { task: Task; step: PlanStep; now: number }) {
  const kids = planChildren(task, step)
  const active = step.status === 'running' || step.status === 'waiting'
  const [manual, setManual] = useState<boolean | null>(null)
  // 状态一变就回到默认：做完的立即收起，开始做的展开
  useEffect(() => setManual(null), [step.status])
  const open = kids.length > 0 && (manual ?? active)
  const meta = itemMeta(step, now)
  const doneKids = kids.filter((c) => c.status === 'done').length
  return (
    <li>
      <button
        type="button"
        disabled={!kids.length}
        aria-expanded={kids.length ? open : undefined}
        onClick={() => setManual(!open)}
        className={cn(
          'flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left',
          kids.length ? 'cursor-pointer hover:bg-sel' : 'cursor-default',
          step.status === 'running' && 'bg-accent/6',
        )}
      >
        <span className="mt-0.5">
          <PlanIcon status={step.status} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                'min-w-0 flex-1 text-[0.8125rem] leading-5',
                step.status === 'done' ? 'text-muted' : step.status === 'pending' ? 'text-fg/80' : 'text-fg',
                step.status === 'running' && 'font-medium',
              )}
            >
              {step.title}
            </span>
            {kids.length > 0 && (
              <span className="shrink-0 font-mono text-[0.6875rem] text-subtle tabular-nums">
                {doneKids}/{kids.length}
              </span>
            )}
          </span>
          {(meta || step.note) && (
            <span
              className={cn('line-clamp-2 text-xs', step.status === 'waiting' ? 'text-warning' : 'text-subtle')}
              title={step.note || meta}
            >
              {[meta, step.status === 'waiting' && step.waits.some((w) => w.state === 'waiting') ? '' : step.note]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </span>
        {kids.length > 0 && (
          <ChevronRight
            className={cn('mt-1 h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')}
          />
        )}
      </button>
      {open && (
        <ol className="mb-1 ml-[1.0625rem] flex flex-col border-l border-line pl-2.5">
          {kids.map((c) => {
            const m = itemMeta(c, now)
            return (
              <li key={c.id} className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1">
                <span className="mt-px">
                  <PlanIcon status={c.status} small />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      'text-xs leading-[1.125rem]',
                      c.status === 'done' ? 'text-subtle' : c.status === 'running' ? 'text-fg' : 'text-muted',
                    )}
                  >
                    {c.title}
                  </span>
                  {(m || c.note) && (
                    <span
                      className={cn(
                        'truncate text-[0.6875rem]',
                        c.status === 'waiting' ? 'text-warning' : 'text-subtle',
                      )}
                    >
                      {[m, c.note].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </li>
  )
}

/** 做完的计划下面的总结：Agent 写的；它没写、面板取了最后的回复时标出来 */
function PlanSummary({ plan, teamNames }: { plan: TaskPlan; teamNames: Set<string> }) {
  return (
    <div className="mx-1 mt-2 rounded-lg border border-line bg-field/50 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
        <CircleCheck className="h-3.5 w-3.5 text-success" />
        {t('总结')}
        {plan.autoSummary && (
          <span className="font-normal text-subtle">{t('（AI 没写总结，取的是最后一条回复）')}</span>
        )}
      </div>
      {plan.summary ? (
        <Markdown text={plan.summary} teamNames={teamNames} className="text-[0.8125rem]" />
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('步骤都完成了，AI 正在写总结')}
        </p>
      )}
    </div>
  )
}

/** 以前的一份计划：一行标题和步骤数，点开看步骤和总结 */
function OldPlan({ plan, teamNames }: { plan: TaskPlan; teamNames: Set<string> }) {
  const [open, setOpen] = useState(false)
  const done = plan.steps.filter((s) => s.status === 'done').length
  const at = plan.doneAt ? new Date(plan.doneAt) : null
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-sel"
      >
        <PlanIcon status={plan.doneAt ? 'done' : 'pending'} small />
        <span className="min-w-0 flex-1 truncate text-xs text-fg">{plan.title || t('未命名的计划')}</span>
        <span className="shrink-0 text-[0.6875rem] text-subtle tabular-nums">
          {t('{done}/{total} 步', { done, total: plan.steps.length })}
          {at &&
            ` · ${at.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
        </span>
      </button>
      {open && (
        <div className="mb-1 ml-6 flex flex-col gap-1 pr-1">
          <ol className="flex flex-col gap-0.5">
            {plan.steps.map((s) => (
              <li key={s.id} className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                <PlanIcon status={s.status} small />
                <span className="truncate">{s.title}</span>
              </li>
            ))}
          </ol>
          {plan.summary && <PlanSummary plan={plan} teamNames={teamNames} />}
        </div>
      )}
    </li>
  )
}
