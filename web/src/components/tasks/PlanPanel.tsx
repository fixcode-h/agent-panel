import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, CircleCheck, ListChecks } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PlanItem, PlanStatus, PlanStep, Task, TaskPlan } from '@shared/schema'
import { planChildren, planProgress, shownPlan } from '@shared/plan'
import { fmtDuration } from '@/lib/tasks'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<PlanStatus, string> = {
  pending: t('待做'),
  running: t('进行中'),
  waiting: t('等待中'),
  done: t('完成'),
}

/**
 * 等待中的沙漏：上腔的沙流到下半腔堆起来，中轴一条细沙在落，一轮流完整体翻个身接着流。
 * 动效全在 index.css（plan-hourglass-*）：翻转只在沙全落到下腔时做，
 * 而且翻转后画出来的样子和初始状态重合，所以循环回开头不闪跳
 */
function PlanHourglass({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={cn('plan-hourglass', className)}>
      <g className="plan-hourglass-turn">
        {/* 上腔、下腔的沙：同一段 scaleY 动画，下半腔晚半个循环 */}
        <polygon points="7.45,3.45 16.55,3.45 12.65,10.4 11.35,10.4" className="plan-hourglass-sand" />
        <polygon
          points="11.35,13.6 12.65,13.6 16.55,20.55 7.45,20.55"
          className="plan-hourglass-sand plan-hourglass-sand-bottom"
        />
        <path
          className="plan-hourglass-glass"
          d="M6.2 2.6h11.6M6.2 21.4h11.6M7 3l4.3 7.8v2.4L7 21M17 3l-4.3 7.8v2.4L17 21"
        />
        <line className="plan-hourglass-stream" x1="12" y1="10.2" x2="12" y2="18.6" />
        {/* 翻转 180° 后落沙是在上半腔那边，所以另一条线晚半个循环出现 */}
        <line className="plan-hourglass-stream plan-hourglass-stream-up" x1="12" y1="5.4" x2="12" y2="13.8" />
      </g>
    </svg>
  )
}

/**
 * 计划步骤的勾选圆点（清单样式）：完成是实心圆里一个勾，待做是空心圆，
 * 进行中是转动的强调色圆弧，等待中是圆里一个流动并翻转的沙漏
 */
function PlanIcon({ status, small }: { status: PlanStatus; small?: boolean }) {
  const box = cn('grid shrink-0 place-items-center rounded-full', small ? 'h-3.5 w-3.5' : 'h-[1.125rem] w-[1.125rem]')
  const label = STATUS_LABEL[status]
  if (status === 'done')
    return (
      <span role="img" aria-label={label} className={cn(box, 'bg-muted text-card')}>
        <Check className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={3} />
      </span>
    )
  if (status === 'running')
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(box, 'animate-spin border-2 border-accent/25 border-t-accent')}
      />
    )
  if (status === 'waiting')
    return (
      <span role="img" aria-label={label} className={cn(box, 'border-[1.5px] border-warning text-warning')}>
        <PlanHourglass className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      </span>
    )
  return <span role="img" aria-label={label} className={cn(box, 'border-[1.5px] border-line-strong')} />
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
            <PlanHourglass className="h-3 w-3" />
            {t('{n} 个在等待', { n: p.waiting })}
          </span>
        )}
      </button>
      {open && <PlanWindow task={task} plan={plan} />}
    </div>
  )
}

/** 计划窗口：当前计划的步骤（进行中的展开子步骤）；下面能翻以前的计划 */
function PlanWindow({ task, plan }: { task: Task; plan: TaskPlan }) {
  const p = planProgress(task, plan)
  const live = !plan.doneAt
  const now = useNow(live)
  const older = task.plans.slice(0, -1).reverse()
  const [history, setHistory] = useState(false)
  return (
    <div
      role="dialog"
      aria-label={t('执行计划')}
      className="absolute bottom-full left-0 z-30 mb-1 flex max-h-[min(64vh,560px)] w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop"
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-subtle" title={plan.title}>
          {plan.title || t('执行计划')}
        </span>
        <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">
          {p.done}/{p.total}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ol className="flex flex-col">
          {plan.steps.map((s) => (
            <PlanStepRow key={s.id} task={task} step={s} now={now} />
          ))}
        </ol>
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
                  <OldPlan key={x.id} plan={x} />
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
          'flex w-full min-w-0 items-start gap-3 rounded-lg px-2 py-2 text-left',
          kids.length ? 'cursor-pointer hover:bg-sel' : 'cursor-default',
        )}
      >
        <span className="mt-[0.0625rem]">
          <PlanIcon status={step.status} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                'min-w-0 flex-1 text-[0.875rem] leading-5',
                step.status === 'pending' ? 'text-muted' : 'text-fg',
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
        <ol className="mb-1 ml-[2.4375rem] flex flex-col">
          {kids.map((c) => {
            const m = itemMeta(c, now)
            return (
              <li key={c.id} className="flex min-w-0 items-start gap-2.5 rounded-md py-1 pr-2">
                <span className="mt-0.5">
                  <PlanIcon status={c.status} small />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      'text-[0.8125rem] leading-[1.125rem]',
                      c.status === 'pending' ? 'text-subtle' : c.status === 'running' ? 'text-fg' : 'text-muted',
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

/** 以前的一份计划：一行标题和步骤数，点开看步骤 */
function OldPlan({ plan }: { plan: TaskPlan }) {
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
        </div>
      )}
    </li>
  )
}
