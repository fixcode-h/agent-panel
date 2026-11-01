import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Loader2, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { fmtDuration } from '@shared/duration'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { useData } from '@/lib/data'
import {
  backgroundSteps,
  blockingFailed,
  blockingSettled,
  stepElapsed,
  traceRunning,
  type TraceStatus,
  type TraceStep,
  type TraceStepId,
} from '@/lib/load-trace'
import { cn } from '@/lib/utils'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 打开对话时的加载日志：像终端那样一行一步，卡在哪一眼能看到。
 * 状态全部来自真实请求（见 load-trace 与 TaskView 里的埋点），不伪造进度；
 * 这里只管画，以及「走完后停一小会儿再淡出」。
 *
 * 分步日志只在开发者模式（设置 → 常规）里显示：平时打开对话只给一个转圈（没有数据时）或什么都不画
 * （数据到了、盖在对话上的那一层）。挡内容的步骤失败时照样显示错误卡片——错误原文不吞。
 */

/** 每一步叫什么，按加载顺序（文案在模块顶层翻，和 web/src/lib/tasks.ts 的 statusLabel 一样） */
const LABEL: Record<TraceStepId, string> = {
  task: t('读取对话'),
  stream: t('连接实时更新'),
  children: t('读取子对话'),
  seen: t('标记已读'),
  render: t('渲染消息'),
}

/** 后台胶囊上那一句：说清这会儿卡在哪一步（按加载顺序取第一个还在跑的） */
const RUNNING_TEXT: Record<TraceStepId, string> = {
  task: t('正在读取对话'),
  stream: t('正在连接实时更新'),
  children: t('正在读取子对话'),
  seen: t('正在标记已读'),
  render: t('正在渲染消息'),
}

/** 状态图标：完成、进行中、等待中、失败、未执行 —— 关掉动效时靠形状也分得开 */
const ICON: Record<TraceStatus, { text: string; cls: string; spin?: boolean }> = {
  waiting: { text: '·', cls: 'text-subtle' },
  running: { text: '⟳', cls: 'text-accent-text', spin: true },
  done: { text: '✓', cls: 'text-success' },
  failed: { text: '✗', cls: 'text-danger' },
  skipped: { text: '–', cls: 'text-subtle' },
}

/**
 * 日志至少露这么久再淡出：几十毫秒就加载完的对话也要能看清走了哪几步。
 * 这不是假等待——这几步是真的跑过了，只是快到看不见；对话内容此时已经在下面渲染好了。
 */
const MIN_VISIBLE_MS = 450
/** 淡出时长，和卡片上的 duration-200 一致；淡完再交给调用方卸载 */
const FADE_MS = 200
/** 各行出现时的错开间隔：自上而下依次淡入，像终端逐行打出来 */
const ROW_FADE_STEP_MS = 40

export function LoadTrace({
  steps,
  overlay = false,
  onHidden,
}: {
  steps: TraceStep[]
  /** 有任务数据之后盖在对话区上淡出（此时对话已经在下面画好）；没有数据时它就是页面主体 */
  overlay?: boolean
  /** 淡出结束：调用方把这块卸载掉 */
  onHidden?: () => void
}) {
  // 挡内容的步骤（读取对话、渲染消息）都结束了就能换成对话：实时更新、子对话列表、标记已读
  // 是内容之外的增强，慢不慢都不该让面板一直盖着（用户报的就是「连接实时更新」等到 1.2 秒还挡着）
  const blocking = blockingSettled(steps)
  // 只有挡内容的步骤失败才停在屏幕上：错误原文要给人看，用户看清后自己关。
  // 后台步骤失败不挡内容，改由收起后的日志胶囊显示错误原文（见 LoadTracePill）
  const failed = blockingFailed(steps)
  // 有步骤还在跑才每秒刷新：等待时长要看得见地涨，跑完了就不必再重渲染
  const now = useNow(traceRunning(steps))
  const dev = useData().settings?.developerMode === true
  const [shown, setShown] = useState(true)
  const hidden = useRef(onHidden)
  hidden.current = onHidden
  // 计时基准取第一步真正开始的时刻，不是这块组件挂载的时刻：
  // 没有数据时它是页面主体，数据到了会换成盖在对话上的那一层（重新挂载），
  // 两段都从自己挂载算就会把「最少露 450ms」叠两遍，白白多等一截
  const startedAt = steps.reduce<number>(
    (min, s) => (s.startedAt !== undefined && s.startedAt < min ? s.startedAt : min),
    Number.POSITIVE_INFINITY,
  )
  useEffect(() => {
    // 只有盖在对话上的那一层会淡出卸载；没有任务数据时它就是页面的内容，
    // 阻塞步骤失败时要停在屏幕上给人看（淡成空白比转圈更糟）
    if (!overlay || !blocking || failed) return
    const base = Number.isFinite(startedAt) ? startedAt : Date.now()
    // 不在开发者模式时这一层本来就不画，不必为了「看清走了哪几步」多停一会儿
    const left = dev ? Math.max(0, MIN_VISIBLE_MS - (Date.now() - base)) : 0
    const timer = setTimeout(() => setShown(false), left)
    return () => clearTimeout(timer)
  }, [overlay, blocking, failed, startedAt, dev])
  useEffect(() => {
    if (shown) return
    // 淡出完就交给调用方卸载。不靠 transitionend：动效被关掉、标签页在后台时它不一定来，
    // 那样这层会一直盖在对话上
    const timer = setTimeout(() => hidden.current?.(), FADE_MS + 60)
    return () => clearTimeout(timer)
  }, [shown])

  // 不在开发者模式：不显示分步日志。没有数据时它是页面主体，留一个转圈表示在加载；
  // 盖在对话上的那一层什么都不画（不挡、不变暗），挡内容的步骤走完照常交给调用方卸载
  if (!dev && !failed)
    return overlay ? null : (
      <div className="flex w-full flex-1 items-center justify-center" data-load-spinner="">
        <Loader2 className="h-4 w-4 animate-spin text-subtle" aria-label={t('加载中…')} />
      </div>
    )

  return (
    <div
      className={cn(
        // flex-1：没有任务数据时它撑满对话区，让卡片在中间；绝对定位盖住对话时由 inset-0 撑开。
        // 盖住时不拦鼠标：对话数据已经到了、只是子对话或实时更新慢的时候，用户还能滚着看（卡住≠不能用）
        'flex w-full flex-1 justify-center px-6',
        overlay
          ? 'pointer-events-none absolute inset-0 z-20 items-center bg-bg/60 backdrop-blur-[1px]'
          : 'items-center',
      )}
      data-load-trace=""
    >
      <div
        className={cn(
          'w-full max-w-[520px] rounded-xl border border-line/70 bg-panel/85 px-4 py-3 font-mono text-footnote leading-5 shadow-card transition-opacity',
          // 失败时卡片上有「关闭」按钮，这一块要能点；其他时候不拦鼠标
          overlay && failed && 'pointer-events-auto',
          shown ? 'opacity-100 duration-150' : 'opacity-0 duration-200',
        )}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className={cn('text-caption tracking-wide', failed ? 'text-danger' : 'text-subtle')}>
            {failed ? t('加载失败') : t('加载对话')}
          </span>
          {/* 失败时不自动淡出，给一个手动关的出口，关掉后下面的对话照常操作 */}
          {overlay && failed && (
            <button
              type="button"
              onClick={() => setShown(false)}
              aria-label={t('关闭')}
              className="shrink-0 rounded-sm p-0.5 text-subtle transition-colors hover:bg-sel hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-0.5">
          {steps.map((step, i) => (
            <TraceLine key={step.id} step={step} now={now} delayMs={i * ROW_FADE_STEP_MS} />
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * 面板收起以后还在跑的后台步骤（实时更新、子对话列表、标记已读）：在输入框上方留一个小胶囊，
 * 失败时直接写错误原文，点开是完整日志。没有在跑 / 失败的后台步骤时什么也不画——不新增常驻噪音。
 * 不在开发者模式时只在失败时出现（错误原文不吞），「正在连接实时更新」这类进度不显示。
 */
export function LoadTracePill({ steps }: { steps: TraceStep[] }) {
  const pending = backgroundSteps(steps)
  const dev = useData().settings?.developerMode === true
  const [open, setOpen] = useState(false)
  const now = useNow(traceRunning(pending))
  useEscape(open, () => setOpen(false))
  // 后台步骤都好了就把浮层收起来：不把它停在一份已经过时的日志上
  useEffect(() => {
    if (!pending.length) setOpen(false)
  }, [pending.length])
  if (!pending.length) return null
  const failed = pending.find((s) => s.status === 'failed')
  if (!dev && !failed) return null
  const running = pending.find((s) => s.status === 'running')
  return (
    <div className="shrink-0 px-3 pt-1 md:px-6">
      <div className="relative mx-auto max-w-(--content-w)">
        <button
          type="button"
          aria-expanded={open}
          aria-label={failed ? t('后台加载失败，查看加载日志') : t('后台加载中，查看加载日志')}
          onClick={() => setOpen((v) => !v)}
          data-load-trace-pill=""
          data-trace-failed={failed ? '1' : undefined}
          className={cn(
            'flex max-w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors',
            failed ? 'text-danger hover:bg-danger/10' : 'text-subtle hover:bg-sel hover:text-fg',
          )}
        >
          {failed ? (
            <CircleAlert className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          )}
          {/* 失败时显示错误原文（不吞）；正常时只说正在做哪一步 */}
          <span className="min-w-0 truncate">{failed ? failed.error : running ? RUNNING_TEXT[running.id] : ''}</span>
        </button>
        {open && (
          // 宽度按视口算：挂靠的是状态栏里的一小块，按父元素百分比会太窄
          <ComposerPopover role="dialog" aria-label={t('加载日志')} width="min(420px, calc(100vw - 2rem))">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="text-body font-medium">{t('加载日志')}</span>
              <span className="text-xs text-subtle">{t('后台步骤')}</span>
              <IconButton size="2xs" icon={X} label={t('关闭')} onClick={() => setOpen(false)} className="ml-auto" />
            </div>
            {/* 五步都列出来：哪几步结束了、哪几步还在后台，一眼看全 */}
            <ul className="flex flex-col gap-0.5 px-3 py-2 font-mono text-footnote leading-5">
              {steps.map((step, i) => (
                <TraceLine key={step.id} step={step} now={now} delayMs={i * ROW_FADE_STEP_MS} />
              ))}
            </ul>
          </ComposerPopover>
        )}
      </div>
    </div>
  )
}

function TraceLine({ step, now, delayMs }: { step: TraceStep; now: number; delayMs: number }) {
  const icon = ICON[step.status]
  const ms = stepElapsed(step, now)
  const time =
    ms === undefined ? '' : step.status === 'running' ? t('已等 {time}', { time: fmtDuration(ms) }) : fmtDuration(ms)
  const state =
    step.status === 'done'
      ? t('完成')
      : step.status === 'running'
        ? t('进行中')
        : step.status === 'failed'
          ? t('失败')
          : step.status === 'skipped'
            ? t('未执行')
            : t('等待中')
  return (
    <li
      className="trace-line flex items-start gap-2"
      style={{ animationDelay: `${delayMs}ms` }}
      // 界面检查靠它断言「渲染消息」真的记到了耗时（漏起点会恒为 0s）
      data-trace-step={step.id}
      data-trace-ms={ms === undefined ? '' : Math.round(ms)}
    >
      <span
        className={cn('mt-px w-3 shrink-0 text-center leading-5', icon.cls, icon.spin && 'inline-block animate-spin')}
        aria-hidden
      >
        {icon.text}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              step.status === 'running' ? 'text-accent-text' : step.status === 'failed' ? 'text-danger' : 'text-fg',
            )}
          >
            {LABEL[step.id]}
          </span>
          {/* 耗时和状态不参与截断：窄窗口里先截步骤名，右边这一列始终在 */}
          <span
            className={cn(
              'shrink-0 tabular-nums',
              step.status === 'running' ? 'text-accent-text' : step.status === 'failed' ? 'text-danger' : 'text-subtle',
            )}
          >
            {time ? `${state} · ${time}` : state}
          </span>
        </div>
        {step.detail && <div className="text-caption break-words text-subtle">{step.detail}</div>}
        {/* 错误原文照原样显示，不吞掉 */}
        {step.error && <div className="text-caption break-words whitespace-pre-wrap text-danger">{step.error}</div>}
      </div>
    </li>
  )
}
