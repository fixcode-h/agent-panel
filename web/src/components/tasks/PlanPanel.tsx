import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, CircleCheck, CircleSlash, ListChecks, TriangleAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PlanItem, PlanStatus, PlanStep, PlanWait, Task, TaskPlan } from '@shared/schema'
import {
  itemStale,
  needsFix,
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
import { ComposerPopover } from '@/components/ui/composer-popover'
import { Progress } from '@/components/ui/progress'

const STATUS_LABEL: Record<PlanStatus, string> = {
  pending: t('待做'),
  running: t('进行中'),
  waiting: t('等待中'),
  done: t('完成'),
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
 * 读屏报原始的 3/8（raw），界面检查也按 data-plan-bar 上的这两个值断言
 */
function PlanBar({ done, total, className }: { done: number; total: number; className?: string }) {
  return (
    <Progress
      data-plan-bar=""
      value={done}
      max={total}
      raw
      label={t('计划进度 {done}/{total}', { done, total })}
      className={className}
    />
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
  // 跳过：静止的圈里一道减号。计划里没有「失败」：没做成的一步仍是进行中，备注用红字写「需要修复：原因」
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
      // 定宽右对齐：各步的用时上下对成一列
      className="min-w-[3.25rem] shrink-0 text-right font-mono text-caption text-subtle tabular-nums"
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
  return (
    <div ref={ref} className="relative flex min-w-0 shrink items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('执行计划')}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-body text-muted transition-colors hover:bg-sel hover:text-fg',
          open && 'bg-sel text-fg',
        )}
      >
        {head === 'done' ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : head === 'closed' ? (
          <CircleSlash className="h-3.5 w-3.5 shrink-0 text-subtle" />
        ) : (
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-subtle" />
        )}
        {/* 提前结束但还有遗留：标题和徽标都要说「已结束、还剩几步」，不能只写「计划已完成」 */}
        <span className="shrink-0 font-medium">
          {head === 'done'
            ? t('计划已完成')
            : head === 'closed'
              ? t('计划已结束')
              : t('计划 {done}/{total}', { done: p.done, total: p.total })}
        </span>
        {left > 0 && (
          <span data-plan-left="" className="shrink-0 text-xs text-subtle">
            {t('{n} 步没做完（已保留）', { n: left })}
          </span>
        )}
        {!finished && <PlanBar done={p.done} total={p.total} className="w-10 shrink-0 sm:w-14" />}
        {!finished && current && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-subtle">
            <span>·</span>
            <span className="min-w-0 truncate">{current}</span>
            {withTime && (
              <span
                data-plan-current-time=""
                title={t('用时 {time}', { time: currentTime })}
                aria-label={t('用时 {time}', { time: currentTime })}
                className="shrink-0 font-mono tabular-nums"
              >
                {currentTime}
              </span>
            )}
          </span>
        )}
        {!finished && p.waiting > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-warning">
            <WaitRing className="h-3 w-3" />
            {t('{n} 个在等待', { n: p.waiting })}
          </span>
        )}
        {/* 空间够时再显示「多久前更新」：窄窗口里前面的进度已经说明了状态 */}
        {!finished && <UpdatedAt at={updatedAt} stale={stale} className="hidden text-xs sm:inline" />}
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
    <ComposerPopover
      role="dialog"
      aria-label={t('执行计划')}
      width="min(460px, calc(100vw - 2rem))"
      className="max-h-[min(64vh,560px)]"
    >
      {/* 窗口头：标题和计数一行，细进度条一行，总用时 · 多久前更新一行小字；和下面的步骤用分隔线隔开 */}
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <ListChecks className="h-4 w-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg" title={plan.title}>
            {plan.title || t('执行计划')}
          </span>
          <span className="shrink-0 font-mono text-xs text-muted tabular-nums">
            {p.done}/{p.total}
          </span>
        </div>
        <PlanBar done={p.done} total={p.total} className="h-1" />
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-subtle">
          {total !== undefined && (
            <span
              data-plan-total=""
              title={t('总用时 {time}', { time: fmtDuration(total) })}
              aria-label={t('总用时 {time}', { time: fmtDuration(total) })}
              className="shrink-0 font-mono tabular-nums"
            >
              {fmtDuration(total)}
            </span>
          )}
          {total !== undefined && updatedAt && <span aria-hidden>·</span>}
          <UpdatedAt at={updatedAt} stale={stale} />
          {planRebuilt(task) && (
            <span
              data-plan-rebuilt=""
              className="ml-auto shrink-0 rounded-sm bg-sel px-1.5 py-px"
              title={t('上一份计划没做完就结束了，这是新开的一份')}
            >
              {t('重建')}
            </span>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        <ol className="flex flex-col gap-0.5">
          {plan.steps.map((s, i) => (
            <PlanStepRow
              key={s.id}
              task={task}
              step={s}
              now={now}
              waitingKids={children}
              settled={settled}
              last={i === plan.steps.length - 1}
            />
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
    </ComposerPopover>
  )
}

/** 一个主步骤：进行中、等待中的默认展开子步骤，做完立即收起；点一下可以手动展开收起 */
function PlanStepRow({
  task,
  step,
  now,
  waitingKids,
  settled,
  last,
}: {
  task: Task
  step: PlanStep
  now: number
  /** 父对话页的子对话列表：等待中的子对话在这里显示它在做什么、多久没动静 */
  waitingKids?: WaitChild[]
  /** 这份计划已经结束了：没做完的步骤画成静止的「未完成」，不再写成等待中 / 进行中 */
  settled?: boolean
  /** 最后一步：下面不再画连到下一步的竖线 */
  last?: boolean
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
    <li className="relative">
      {/* 步骤之间的竖线：从这一步的圆点下面连到下一步，读起来是一条从上到下的进度线 */}
      {!last && <span aria-hidden className="absolute top-[1.875rem] bottom-0 left-[1.0625rem] w-px bg-line" />}
      <button
        type="button"
        disabled={!kids.length}
        aria-expanded={kids.length ? open : undefined}
        onClick={() => setManual(!open)}
        className={cn(
          'relative flex w-full min-w-0 items-start gap-3 rounded-lg px-2 py-2 text-left',
          // 正在做的这一步整行浅底：一眼找到当前在哪
          active && !settled && 'bg-sel/60',
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
                'min-w-0 flex-1 truncate text-body leading-5',
                // 完成的只调灰、不加删除线（用户要求）：左边的完成图标已经说明了状态，划掉反而看不清做了什么
                step.status === 'pending' || step.status === 'skipped' || step.status === 'done'
                  ? 'text-muted'
                  : 'text-fg',
                active && 'font-medium',
              )}
            >
              {step.title}
            </span>
            {kids.length > 0 && (
              <span className="shrink-0 font-mono text-caption text-subtle tabular-nums">
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
                needsFix(step) && !settled
                  ? 'text-danger'
                  : step.status === 'waiting' && !settled
                    ? 'text-warning'
                    : 'text-subtle',
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
                        'min-w-0 flex-1 truncate text-body leading-[1.125rem]',
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
                        'truncate text-caption',
                        needsFix(c) && !settled
                          ? 'text-danger'
                          : c.status === 'waiting' && !settled
                            ? 'text-warning'
                            : 'text-subtle',
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
        <span className="shrink-0 text-caption text-subtle tabular-nums">
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
