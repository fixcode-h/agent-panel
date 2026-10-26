import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { ListTree, Loader2, Sparkles, Square, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import type { Task, TaskStep } from '@shared/schema'
import { useData } from '@/lib/data'
import { api } from '@/lib/api'
import { currentActivity, fmtDuration, stepActivity } from '@/lib/tasks'
import { helperRunning, sortHelpers, stepMs } from '@shared/task'
import { useNow } from '@/lib/useNow'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { helperBriefView } from '@/lib/helper-brief'
import { useEscape } from '@/lib/useEscape'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { StepIcon } from './TaskStatusIcon'
import { Msgs } from './Messages'
import { AnalyzeDialog } from './Evolution'
import { HelperBriefCard } from './HelperBriefCard'
import { startAnalysis } from '@/lib/task-transfer'
import { t } from '@shared/i18n'
import { isHelperAgent } from '@shared/builtin/core'

/** 子任务用了多久：没开始也没结束的不显示（排队中），正在跑的跟着 now 每秒变 */
const helperTime = (step: TaskStep, now: number) =>
  step.startedAt || step.endedAt ? fmtDuration(stepMs(step, now)) : ''

/** 还能终止：在跑或在排队 */
const stoppable = (s: TaskStep) => s.status === 'running' || s.status === 'pending'

/** 终止一个子任务：结果推送会把状态带回来，这里只管报错 */
async function stopHelper(task: Task, step: TaskStep) {
  try {
    await api.stopSubtask(task.id, step.id)
    toast.success(t('已终止子任务「{title}」', { title: step.title }))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/**
 * 对话里派出的子任务（按派出顺序、去重）：输入框上方的「子任务」栏和消息流里的运行区读同一份。
 * 工作流任务里节点自己派的子 Agent 显示在节点里，不算；旧数据里只留下「派出了哪几个」而 step 已经没了的不列
 */
export function chatHelperIds(task: Task) {
  if (task.mode === 'workflow' || (task.runs?.length ?? 0) > 0) return []
  const known = new Set(task.steps.map((s) => s.id))
  return [...new Set(task.messages.flatMap((m) => m.spawned ?? []))].filter((id) => known.has(id))
}

/** 终止按钮：列表行、运行区那一行（compact，和行高对齐）和子任务窗口共用 */
export function StopHelper({
  task,
  step,
  label,
  compact,
}: {
  task: Task
  step: TaskStep
  label?: boolean
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)
  if (!stoppable(step)) return null
  return (
    <Button
      variant="ghost"
      size={label ? 'sm' : 'icon-sm'}
      disabled={busy}
      aria-label={t('终止子任务')}
      title={t('终止子任务：在跑的马上结束，排队的不再开始，按「已终止」交回给对话')}
      onClick={async (e) => {
        e.stopPropagation()
        setBusy(true)
        await stopHelper(task, step)
        setBusy(false)
      }}
      className={cn('shrink-0 text-subtle hover:text-danger', compact && 'h-5 w-5 rounded')}
    >
      {busy ? (
        <Loader2 className={cn('animate-spin', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
      ) : (
        <Square className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      )}
      {label && t('终止')}
    </Button>
  )
}

/** 列表分组：和子对话「全部」里同一套分组写法，只是按节点自己的状态分 */
const helperGroups = (list: TaskStep[]) =>
  [
    { key: 'running', label: t('执行中'), items: list.filter(helperRunning) },
    { key: 'pending', label: t('排队中'), items: list.filter((s) => s.status === 'pending') },
    {
      key: 'unfinished',
      label: t('未完成'),
      items: list.filter((s) => s.status === 'failed'),
    },
    { key: 'done', label: t('已完成'), items: list.filter((s) => s.status === 'done') },
    { key: 'stopped', label: t('已终止'), items: list.filter((s) => s.status === 'skipped') },
  ].filter((g) => g.items.length)

/** 列表里每个子任务下面那行：还在跑的写它这会儿在做什么，做完的写交回结果的第一句 */
export function helperBrief(task: Task, step: TaskStep) {
  if (step.status === 'running') return currentActivity(stepActivity(task, step.id, true)) || t('已开始，还没有输出')
  if (step.status === 'pending') return t('子任务在排队，前面的做完就开始')
  if (step.status === 'skipped') return t('已终止，没做完的部分不会交回')
  const out =
    step.output
      .trim()
      .split('\n')
      .find((x) => x.trim()) ?? ''
  return out || t('没有输出')
}

/**
 * 输入框上方的「子任务」入口，单独占状态栏中间一行（计划 → 子任务 → 子对话）、和子对话同一个弹层样式：
 * 派出的子任务不再画在消息流里，点这里的条目打开只读的子任务窗口看它的实时对话流。
 * 栏上只有这一个计数入口（执行中 x/y、失败数），不再把运行中的子任务单独排成卡片——
 * 运行中的卡片只给子对话用，子任务在跑的信息从这里的 x/y 就能看出来。
 */
export function HelperBar({ task, ids, teamNames }: { task: Task; ids: string[]; teamNames: Set<string> }) {
  const { agents } = useData()
  const [open, setOpen] = useState(false)
  // 点开的是哪个子任务的窗口
  const [win, setWin] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEscape(open, () => setOpen(false))
  // 点外面关：和子对话的浮层一样
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  // 顺序见 sortHelpers：执行中 → 排队中 → 未完成 → 已完成 → 已终止，同一档里最新的在最上面
  const steps = sortHelpers(ids.map((id) => task.steps.find((s) => s.id === id)).filter((s): s is TaskStep => !!s))
  const running = steps.filter(helperRunning)
  const failed = steps.filter((s) => s.status === 'failed')
  const now = useNow(running.length > 0)
  // 角色名：默认的「子任务」角色不用再写一遍，点名派给「测试验收」这类角色时才标出来
  const who = (step: TaskStep) => agents.find((a) => a.id === step.agentId && !isHelperAgent(a))
  if (!steps.length) return null

  return (
    <div ref={ref} className="flex min-w-0 shrink-0 items-center gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('子任务')}
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-[0.8125rem] text-muted transition-colors hover:bg-sel hover:text-fg"
      >
        <ListTree className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <span className="shrink-0 font-medium">{t('子任务')}</span>
        {/* 和子对话那一栏同一个写法：在跑时「运行中/总数」，没在跑时只写总数，字号、间距、颜色都对齐 */}
        {running.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1 pr-1 text-xs text-accent tabular-nums">
            <Loader2 className="h-3 w-3 animate-spin" />
            {running.length}/{steps.length}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-subtle tabular-nums">{steps.length}</span>
        )}
        {failed.length > 0 && (
          <span className="shrink-0 rounded-full bg-danger/12 px-1.5 text-[0.6875rem] text-danger">
            {t('{n} 个失败', { n: failed.length })}
          </span>
        )}
      </button>
      {open && (
        // 以这一行状态栏为基准向上弹：和「子对话」的浮层对齐，不挤在按钮下面
        <div className="absolute bottom-full left-0 z-30 mb-1 w-[min(420px,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-line-strong bg-card shadow-pop">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="text-[0.8125rem] font-medium">{t('子任务')}</span>
            <span className="text-xs text-subtle">
              {running.length ? t('{n} 个执行中', { n: running.length }) : t('共 {n} 个', { n: steps.length })}
            </span>
          </div>
          <div className="max-h-[min(46vh,320px)] overflow-y-auto p-1">
            {helperGroups(steps).map((g) => (
              <Fragment key={g.key}>
                <p className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-subtle">
                  {g.label} · {g.items.length}
                </p>
                {g.items.map((s) => {
                  const agent = who(s)
                  return (
                    // 行和终止按钮并排：按钮不能嵌在打开窗口的按钮里
                    <div
                      key={s.id}
                      className="flex min-w-0 items-start gap-1 rounded-lg transition-colors hover:bg-sel"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setWin(s.id)
                          setOpen(false)
                        }}
                        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left"
                      >
                        <span className="mt-0.5 shrink-0">
                          <StepIcon status={s.status} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 truncate text-[0.8125rem]">{s.title}</span>
                            {agent && (
                              <span className="flex shrink-0 items-center gap-1 rounded-full bg-field px-1.5 text-[0.6875rem] text-subtle">
                                <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
                                {agent.name}
                              </span>
                            )}
                            {s.status === 'running' && (
                              <span className="shrink-0 text-[0.6875rem] text-accent">{t('执行中')}</span>
                            )}
                            {s.status === 'failed' && (
                              <span className="shrink-0 text-[0.6875rem] text-danger">{t('失败')}</span>
                            )}
                          </span>
                          <span className="line-clamp-1 text-xs text-subtle">{helperBrief(task, s)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">
                          {helperTime(s, now)}
                        </span>
                      </button>
                      <span className="shrink-0 pt-1 pr-1">
                        <StopHelper task={task} step={s} />
                      </span>
                    </div>
                  )
                })}
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {win && <HelperWindow task={task} id={win} teamNames={teamNames} onClose={() => setWin('')} />}
    </div>
  )
}

/** 子任务窗口：只读的对话流，跟着父对话的推送实时更新；没有输入框 */
export function HelperWindow({
  task,
  id,
  teamNames,
  onClose,
}: {
  task: Task
  id: string
  teamNames: Set<string>
  onClose: () => void
}) {
  const { agents } = useData()
  const step = task.steps.find((s) => s.id === id)
  // 点「AI 分析」开的是复用执行记录那一套的弹窗，只把范围收窄到这一步
  const [analyzing, setAnalyzing] = useState(false)
  const live = step?.status === 'running'
  const now = useNow(live)
  // 这个子任务自己的消息（旧数据里它再派出去的也在它名下）
  const msgs = task.messages.filter((m) => m.step === id || m.step.startsWith(`${id}/`))
  const agent = agents.find((a) => a.id === step?.agentId && !isHelperAgent(a))
  // 有要求时打开先停在最上面：那块「派给它的要求」说明这个子任务要做什么，贴底会把它滚出视野，
  // 用户滚到底部附近之后才跟着新内容走（startAt: 'top'）。
  // 没有要求（旧记录 / 派发时只写了标题）时卡片整块不渲染，滚动区第一块就是对话流，停顶部没有意义——
  // 这种窗口照旧贴底看最新输出，所以按有没有要求选起点
  // 缓存：brief 动辄几千字，而跑着的子任务会因 useNow 高频重渲染，别每次都重新拆一遍
  const hasBrief = useMemo(() => !helperBriefView(step?.brief).empty, [step?.brief])
  const scroller = useStickToBottom(id, undefined, true, hasBrief ? 'top' : 'bottom')
  if (!step) return null
  const time = step.endedAt && !live ? fmtDuration(stepMs(step, now)) : ''
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(820px,calc(100dvh-2rem))] w-[min(880px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-bg shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-4">
            <StepIcon status={step.status} />
            <span className="shrink-0 text-[0.8125rem] text-muted">{t('子任务')}</span>
            <D.Title className="min-w-0 flex-1 truncate text-[0.84375rem] font-medium" title={step.title}>
              {step.title}
            </D.Title>
            {agent && (
              <span className="hidden shrink-0 items-center gap-1.5 text-xs text-subtle sm:flex">
                <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
                {agent.name}
              </span>
            )}
            {time && <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">{time}</span>}
            {/* 窄屏只留图标：留个 aria-label 和 title，否则入口没有可访问名、悬停也没有提示 */}
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('AI 分析')}
              title={t('让 AI 分析这一步的耗时、角色符合度和优化空间')}
              onClick={() => setAnalyzing(true)}
            >
              <Sparkles className="h-4 w-4" />
              <span className="hidden sm:inline">{t('AI 分析')}</span>
            </Button>
            <StopHelper task={task} step={step} label />
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-(--content-w) flex-col gap-4 px-4 py-5 md:px-6">
              {/* 派发时交给它的要求放在最上面：先知道这个子任务要做什么，再看它怎么做的。
                  它就是普通的第一块内容，不吸顶（吸顶会盖住下面的对话流）；窗口打开时停在顶部所以它一开始就看得见。
                  有对话流时默认收起，没有对话流时展开，那正是窗口里要看的内容。展开时先 unpin 再滚到卡片顶部，
                  不然跟随底部会把刚展开的正文顶到视野之上 */}
              <HelperBriefCard
                step={step}
                teamNames={teamNames}
                msgs={msgs.length}
                pin={scroller.pin}
                unpin={scroller.unpin}
              />
              {msgs.length ? (
                <Msgs msgs={msgs} task={task} teamNames={teamNames} live={live} />
              ) : (
                <p className="text-xs text-subtle">{live ? t('已开始，还没有输出') : t('没有输出')}</p>
              )}
            </div>
          </div>
          {/* 子任务没有输入框：做完 CLI 已经退出，这里只能查看 */}
          <footer className="shrink-0 border-t bg-card px-4 py-2.5 text-xs text-subtle">
            {live
              ? t('子任务执行中，做完后结果会自动交回给派它的对话')
              : step.status === 'pending'
                ? t('子任务在排队，前面的做完就开始')
                : step.status === 'failed'
                  ? t('子任务失败了，派它的对话会收到失败原因。这里只能查看')
                  : step.status === 'skipped'
                    ? t('子任务已终止，派它的对话会收到终止原因。这里只能查看')
                    : t('子任务已结束，结果已交回给派它的对话。这里只能查看')}
          </footer>
        </D.Content>
      </D.Portal>
      {/* 弹窗开在子任务窗口之上：分析对话按归属规则开在父对话下，在统一的 AI 分析窗口里看，子任务窗口先关掉 */}
      <AnalyzeDialog
        open={analyzing}
        onOpenChange={setAnalyzing}
        title={t('AI 分析这个子任务')}
        subject={t('子任务 {title}', { title: step.title })}
        intro={t(
          'AI 只读这一个子任务的记录（它的耗时、等待、token、角色设定、派它的要求、对话过程），分析它是不是太慢、有没有跑偏角色、有没有优化空间，面板本身有没有问题。只分析，不改文件。',
        )}
        placeholder={t('例如：为什么这一步这么慢、它有没有做角色以外的事')}
        start={async (focus) => {
          onClose()
          return startAnalysis({
            tasks: [await api.task(task.id)],
            agents,
            projectId: task.projectId,
            focus,
            scope: { stepId: step.id },
            scopeTitle: t('子任务 {title}', { title: step.title }),
          })
        }}
      />
    </D.Root>
  )
}
