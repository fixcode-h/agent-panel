import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, ChevronUp, CircleCheck, CircleSlash, ListChecks, TriangleAlert, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PlanItem, PlanStatus, PlanStep, PlanWait, Task, TaskPlan } from '@shared/schema'
import {
  itemStale,
  planChildren,
  planHeadline,
  planProgress,
  planRebuilt,
  planSpan,
  planUpdatedAt,
  shownPlan,
  unfinishedSteps,
} from '@shared/plan'
import { childActivityText, childWaitText, timeAgo, type ChildActivity, type ChildWait } from '@shared/task'
import { fmtDuration } from '@/lib/tasks'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { StatusPill } from '@/components/ui/status-pill'

const STATUS_LABEL: Record<PlanStatus, string> = {
  pending: t('待做'),
  running: t('进行中'),
  waiting: t('等待中'),
  done: t('完成'),
  failed: t('失败'),
  skipped: t('跳过'),
}

/**
 * 折叠头上「{n} 个在等待」前面的小环：和计划项的「等待中」同一个环；旁边已有文字，不再另挂 aria-label
 */
function WaitRing({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('plan-wait-ring shrink-0 rounded-full border-[1.5px] border-warning', className)}
    />
  )
}

/**
 * 进度条（done/total，done 含明确跳过的步骤）：折叠头和窗口头共用。
 * 宽度用 CSS 过渡，状态推进时能看出「又走了一步」；role=progressbar 让读屏也能拿到 3/8 这件事
 */
function PlanBar({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <span
      role="progressbar"
      data-plan-bar=""
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={t('计划进度 {done}/{total}', { done, total })}
      className={cn('block h-1 overflow-hidden rounded-full bg-sel', className)}
    >
      <span
        className="block h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </span>
  )
}

/** 「2 分钟前更新」：计划的最后变化时间；滞后时用警示色（和步骤行的小标记同一套判定） */
function UpdatedAt({ at, stale, className }: { at?: string; stale?: boolean; className?: string }) {
  if (!at) return null
  const ago = timeAgo(at)
  if (!ago) return null
  const text = t('{ago}更新', { ago })
  return (
    <span
      data-plan-updated=""
      title={t('计划最后更新时间：{ago}', { ago })}
      className={cn('shrink-0 tabular-nums', stale ? 'text-warning' : 'text-subtle', className)}
    >
      {text}
    </span>
  )
}

/**
 * 计划步骤的勾选圆点（清单样式）：完成是实心圆里一个勾，待做是静止的空心圆，
 * 进行中是强调色实线圆弧快转，「等待中」是 warning 色虚线圆环原地呼吸 —— 两者靠形状、动效类型分开，不只看颜色。
 * `settled` 是「计划已经结束了」：这时还没做完的步骤不再画成等待中 / 进行中（计划都不跑了，
 * 画成还在动和折叠头的结论打架），统一画成静止的空心圆、读作「未完成」
 */
function PlanIcon({ status, small, settled }: { status: PlanStatus; small?: boolean; settled?: boolean }) {
  const box = cn('grid shrink-0 place-items-center rounded-full', small ? 'h-3.5 w-3.5' : 'h-[1.125rem] w-[1.125rem]')
  if (settled && status !== 'done')
    return <span role="img" aria-label={t('未完成')} className={cn(box, 'border-[1.5px] border-line-strong')} />
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
  // 等待中是一整圈虚线、原地明暗呼吸：形状（整圈断续 vs 一圈只有一道弧）和动效类型（呼吸 vs 旋转）
  // 都和进行中不同，关掉动效时形状也分得开；颜色和透明度只作辅助
  if (status === 'waiting')
    return <span role="img" aria-label={label} className={cn(box, 'plan-wait-ring border-[1.5px] border-warning')} />
  // 失败：实心警示色 + 叉；跳过：静止的圈里一道减号。形状也和上面几种分得开
  if (status === 'failed')
    return (
      <span role="img" aria-label={label} className={cn(box, 'bg-danger text-card')}>
        <X className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={3} />
      </span>
    )
  if (status === 'skipped')
    return (
      <span role="img" aria-label={label} className={cn(box, 'border-[1.5px] border-line-strong')}>
        <span aria-hidden="true" className="h-[1.5px] w-2 rounded-full bg-subtle" />
      </span>
    )
  return <span role="img" aria-label={label} className={cn(box, 'border-[1.5px] border-line-strong')} />
}

/**
 * 计划面板要显示的子对话现状：等的是哪个子对话、它这会儿在做什么、多久没新输出。
 * 字段和父对话页的 ChildSummary 一致，传进来直接用（等后台命令时没有对应的对象）
 */
export interface WaitChild {
  id: string
  title: string
  working: boolean
  activity?: ChildActivity
  waiting?: ChildWait
  lastActivityAt?: string
}

/** 等待项的一句话：子对话带上它这会儿在做什么、多久没动静，不用再点进子对话去看 */
function waitText(w: PlanWait, kids?: WaitChild[]) {
  const label = w.label || w.ref
  if (w.kind !== 'child') return label
  const c = kids?.find((k) => k.id === w.ref)
  if (!c) return label
  const doing = c.waiting ? childWaitText(c.waiting) : childActivityText(c.activity) || (c.working ? t('执行中') : '')
  const ago = c.lastActivityAt ? t('最后活动 {ago}', { ago: timeAgo(c.lastActivityAt) }) : ''
  return [label, doing, ago].filter(Boolean).join(' · ')
}

/**
 * 一项的用时（毫秒）：进行中、等待中从 startedAt 算到现在（每秒随 now 涨），
 * 完成用 endedAt - startedAt 固定住；待做或没有 startedAt 返回空。
 */
function itemElapsed(x: PlanItem, now: number): number | undefined {
  const from = Date.parse(x.startedAt)
  if (!Number.isFinite(from)) return undefined
  if (x.status === 'done') {
    const end = Date.parse(x.endedAt)
    return Number.isFinite(end) ? Math.max(0, end - from) : undefined
  }
  if (x.status === 'running' || x.status === 'waiting') return Math.max(0, now - from)
  return undefined
}

/** 步骤右侧的用时：和标题分开、等宽数字，窄屏下也不被标题挤掉 */
function ItemTime({ item, now }: { item: PlanItem; now: number }) {
  const ms = itemElapsed(item, now)
  if (ms === undefined) return null
  const time = fmtDuration(ms)
  const label = t('用时 {time}', { time })
  return (
    <span
      data-plan-time=""
      title={label}
      aria-label={label}
      className="shrink-0 font-mono text-[0.6875rem] text-subtle tabular-nums"
    >
      {time}
    </span>
  )
}

/**
 * 进行中但很久没变化的一步：旁边一个小警示图标（不新造弹窗），title 写清多久没更新。
 * 判定和提示词里的滞后检测同一个函数（itemStale），不会出现「界面上没标、提示词里在提醒」
 */
function StaleMark({ ms }: { ms?: number }) {
  if (ms === undefined) return null
  const mins = Math.max(1, Math.round(ms / 60_000))
  return (
    <span
      data-plan-stale-step=""
      title={t('这一步 {n} 分钟没更新了：先收口这一步，再把当前这一步标成进行中', { n: mins })}
      className="shrink-0 text-warning"
    >
      <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{t('这一步 {n} 分钟没更新了', { n: mins })}</span>
    </span>
  )
}

/** 步骤后面的一小段：只写等待中在等什么，用时已经挪到右侧显示，不再在这里重复 */
function itemMeta(x: PlanItem, kids?: WaitChild[]) {
  const waits = x.waits.filter((w) => w.state === 'waiting').map((w) => waitText(w, kids))
  if (x.status === 'waiting' && waits.length)
    // 面板写的 note 在这里一起显示：子对话没交付完时它会写清还在等什么（等的是谁由 waits 带出）
    return [t('等：{what}', { what: waits.join(t('、')) }), x.note].filter(Boolean).join(' · ')
  return ''
}

/** 步骤下面那行小字：等待中 note 已经并进 meta（等谁 + 还在等什么），其余情况再把备注接在后面 */
function itemLine(x: PlanItem, kids?: WaitChild[]) {
  const meta = itemMeta(x, kids)
  const inMeta = x.status === 'waiting' && x.waits.some((w) => w.state === 'waiting')
  return [meta, inMeta ? '' : x.note].filter(Boolean).join(' · ')
}

/**
 * 输入框上方的计划按钮：「计划 2/5 · 正在做的那一步」，点开是实时更新的计划窗口。
 * 只有对话列过计划才显示
 */
export function PlanButton({ task, children }: { task: Task; children?: WaitChild[] }) {
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
  // 计划「结束了」有两种：全部做完（说已完成）和 finish_plan 提前结束、还留着没做完的步骤。
  // 只看 doneAt 会把后者也说成已完成，而列表里那一步还是等待中 —— 用户看到的就是这个矛盾
  const head = plan ? planHeadline(plan) : 'open'
  const finished = head !== 'open'
  // 进行中“正在做的那一步”的用时跟着当前步骤的时间走，每秒刷新；结束的计划不用再每秒重算
  const now = useNow(!!plan && !finished)
  if (!plan) return null
  const p = planProgress(task, plan)
  // 只数主步骤：和窗内进度（p.total - p.done）同一套计数，同屏两个数字不会打架
  const left = head === 'closed' ? unfinishedSteps(plan) : 0
  const current = p.current?.child?.title ?? p.current?.step.title
  const currentMs = p.current ? itemElapsed(p.current.child ?? p.current.step, now) : undefined
  const currentTime = currentMs === undefined ? '' : fmtDuration(currentMs)
  // 当前这一步进行中、又超过阈值没更新：折叠头和窗口里都用警示色
  const stale = !finished && !!p.current && itemStale(p.current.child ?? p.current.step, now) !== undefined
  // 旧计划没有 updatedAt：退回创建时间（planUpdatedAt 是一处判定）
  const updatedMs = planUpdatedAt(plan)
  const updatedAt = updatedMs === undefined ? undefined : new Date(updatedMs).toISOString()
  // 标题里已经带着同样的用时就不重复写一遍
  const withTime = currentTime !== '' && !current?.includes(currentTime)
  // 组件库「计划 · PlanBar」：贴在输入框上方的一整条浅底，「计划 3/6 正在：…」，点开是计划窗口
  return (
    <div ref={ref} className="relative flex min-w-0 flex-1 items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('执行计划')}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-[2.125rem] w-full min-w-0 cursor-pointer items-center gap-2 rounded-[9px] px-2.5 text-[0.78125rem] text-fg transition-colors hover:bg-sel/70',
          open ? 'bg-sel/70' : 'bg-sel/45',
        )}
      >
        {head === 'done' ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : head === 'closed' ? (
          <CircleSlash className="h-3.5 w-3.5 shrink-0 text-subtle" />
        ) : (
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        {/* 提前结束但还有遗留：标题和徽标都要说「已结束、还剩几步」，不能只写「计划已完成」。
            进度胶囊前留一个空格：读屏和界面检查读到的仍是「计划 2/6」 */}
        <span className="shrink-0 font-semibold">
          {head === 'done' ? t('计划已完成') : head === 'closed' ? t('计划已结束') : t('计划')}
        </span>
        {!finished && (
          <>
            {' '}
            <StatusPill tone="ok" className="h-[1.125rem] px-1.5 text-[0.6875rem] tabular-nums">
              {p.done}/{p.total}
            </StatusPill>
          </>
        )}
        {left > 0 && (
          <span data-plan-left="" className="shrink-0 text-xs text-subtle">
            {t('{n} 步没做完（已保留）', { n: left })}
          </span>
        )}
        {!finished && current ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted">
            <span className="min-w-0 truncate">{t('正在：{what}', { what: current })}</span>
            {withTime && (
              <span
                data-plan-current-time=""
                title={t('用时 {time}', { time: currentTime })}
                aria-label={t('用时 {time}', { time: currentTime })}
                className="shrink-0 font-mono text-[0.71875rem] text-subtle tabular-nums"
              >
                {currentTime}
              </span>
            )}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {!finished && p.waiting > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-warning">
            <WaitRing className="h-3 w-3" />
            {t('{n} 个在等待', { n: p.waiting })}
          </span>
        )}
        {/* 空间够时再显示「多久前更新」：窄窗口里前面的进度已经说明了状态 */}
        {!finished && <UpdatedAt at={updatedAt} stale={stale} className="hidden text-xs sm:inline" />}
        <ChevronUp
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && <PlanWindow task={task} plan={plan} children={children} />}
    </div>
  )
}

/** 计划窗口：当前计划的步骤（进行中的展开子步骤）；下面能翻以前的计划 */
function PlanWindow({ task, plan, children }: { task: Task; plan: TaskPlan; children?: WaitChild[] }) {
  const p = planProgress(task, plan)
  const live = !plan.doneAt
  // 计划已经结束（全部做完或提前结束）：还没做完的步骤不再画成等待中 / 进行中
  const settled = !live
  const tick = useNow(live)
  // 已经结束的计划把时间停在 doneAt：提前结束（finish_plan）时还有没做完的步骤，
  // 不能每次打开窗口都按当前时间重算，否则单项用时会超过总用时
  const closedAt = Date.parse(plan.doneAt)
  const now = live || !Number.isFinite(closedAt) ? tick : closedAt
  const total = planSpan(plan, now)
  const older = task.plans.slice(0, -1).reverse()
  const [history, setHistory] = useState(false)
  // 当前步骤进行中但很久没变化：窗口头的「N 分钟前更新」和步骤行的小标记都用它
  const stale = live && !!p.current && itemStale(p.current.child ?? p.current.step, now) !== undefined
  const updatedMs = planUpdatedAt(plan)
  const updatedAt = updatedMs === undefined ? undefined : new Date(updatedMs).toISOString()
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
        {total !== undefined && (
          <span
            data-plan-total=""
            title={t('总用时 {time}', { time: fmtDuration(total) })}
            aria-label={t('总用时 {time}', { time: fmtDuration(total) })}
            className="shrink-0 font-mono text-xs text-subtle tabular-nums"
          >
            {fmtDuration(total)}
          </span>
        )}
        <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">
          {p.done}/{p.total}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
        <PlanBar done={p.done} total={p.total} className="min-w-0 flex-1" />
        {planRebuilt(task) && (
          <span
            data-plan-rebuilt=""
            className="shrink-0 text-[0.6875rem] text-subtle"
            title={t('上一份计划没做完就结束了，这是新开的一份')}
          >
            {t('重建')}
          </span>
        )}
        <UpdatedAt at={updatedAt} stale={stale} className="text-[0.6875rem]" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ol className="flex flex-col">
          {plan.steps.map((s) => (
            <PlanStepRow key={s.id} task={task} step={s} now={now} waitingKids={children} settled={settled} />
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
function PlanStepRow({
  task,
  step,
  now,
  waitingKids,
  settled,
}: {
  task: Task
  step: PlanStep
  now: number
  /** 父对话页的子对话列表：等待中的子对话在这里显示它在做什么、多久没动静 */
  waitingKids?: WaitChild[]
  /** 这份计划已经结束了：没做完的步骤画成静止的「未完成」，不再写成等待中 / 进行中 */
  settled?: boolean
}) {
  const kids = planChildren(task, step)
  const active = step.status === 'running' || step.status === 'waiting'
  const [manual, setManual] = useState<boolean | null>(null)
  // 状态一变就回到默认：做完的立即收起，开始做的展开
  useEffect(() => setManual(null), [step.status])
  const open = kids.length > 0 && (manual ?? active)
  const meta = itemLine(step, waitingKids)
  const doneKids = kids.filter((c) => c.status === 'done').length
  // 计划已经结束了就不标「卡住」：它不会再推进了，标出来只会让人以为还在等它
  const staleMs = settled ? undefined : itemStale(step, now)
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
          <PlanIcon status={step.status} settled={settled} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[0.875rem] leading-5',
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
            <StaleMark ms={staleMs} />
            <ItemTime item={step} now={now} />
          </span>
          {/* itemLine 已经带上备注：这里再接一次 note，同一句话会显示两遍 */}
          {meta && (
            <span
              className={cn(
                'line-clamp-2 text-xs',
                step.status === 'waiting' && !settled ? 'text-warning' : 'text-subtle',
              )}
              title={meta}
            >
              {meta}
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
            const m = itemLine(c, waitingKids)
            return (
              <li key={c.id} className="flex min-w-0 items-start gap-2.5 rounded-md py-1 pr-2">
                <span className="mt-0.5">
                  <PlanIcon status={c.status} small settled={settled} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-[0.8125rem] leading-[1.125rem]',
                        c.status === 'pending' ? 'text-subtle' : c.status === 'running' ? 'text-fg' : 'text-muted',
                      )}
                    >
                      {c.title}
                    </span>
                    <StaleMark ms={settled ? undefined : itemStale(c, now)} />
                    <ItemTime item={c} now={now} />
                  </span>
                  {m && (
                    <span
                      className={cn(
                        'truncate text-[0.6875rem]',
                        c.status === 'waiting' && !settled ? 'text-warning' : 'text-subtle',
                      )}
                    >
                      {m}
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
  const head = planHeadline(plan)
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-sel"
      >
        <PlanIcon status={head === 'done' ? 'done' : 'pending'} small />
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
                {/* 历史计划都是已经结束的：没做完的步骤同样画成「未完成」，不在这里画出等待中的虚线环 */}
                <PlanIcon status={s.status} small settled />
                <span className="truncate">{s.title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  )
}
