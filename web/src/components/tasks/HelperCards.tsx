import { Fragment, useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { ListTree, Loader2, X } from 'lucide-react'
import type { Task, TaskStep } from '@shared/schema'
import { useData } from '@/lib/data'
import { currentActivity, fmtDuration, stepActivity } from '@/lib/tasks'
import { stepMs } from '@shared/task'
import { useNow } from '@/lib/useNow'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { useEscape } from '@/lib/useEscape'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { StepIcon } from './TaskStatusIcon'
import { Msgs } from './Messages'
import { t } from '@shared/i18n'

/** 子任务用了多久：没开始也没结束的不显示（排队中），正在跑的跟着 now 每秒变 */
const helperTime = (step: TaskStep, now: number) =>
  step.startedAt || step.endedAt ? fmtDuration(stepMs(step, now)) : ''

/** 列表里的顺序：正在跑的、排队的、没做完的、做完的；同一组里按派出的顺序 */
const helperRank = (s: TaskStep) =>
  s.status === 'running' ? 0 : s.status === 'pending' ? 1 : s.status === 'failed' ? 2 : 3

/** 列表分组：和子对话「全部」里同一套分组写法，只是按节点自己的状态分 */
const helperGroups = (list: TaskStep[]) =>
  [
    { key: 'running', label: t('执行中'), items: list.filter((s) => s.status === 'running') },
    { key: 'pending', label: t('排队中'), items: list.filter((s) => s.status === 'pending') },
    {
      key: 'unfinished',
      label: t('未完成'),
      items: list.filter((s) => s.status === 'failed'),
    },
    { key: 'done', label: t('已完成'), items: list.filter((s) => s.status === 'done') },
  ].filter((g) => g.items.length)

/** 列表里每个子任务下面那行：还在跑的写它这会儿在做什么，做完的写交回结果的第一句 */
function helperBrief(task: Task, step: TaskStep) {
  if (step.status === 'running') return currentActivity(stepActivity(task, step.id, true)) || t('已开始，还没有输出')
  if (step.status === 'pending') return t('子任务在排队，前面的做完就开始')
  const out =
    step.output
      .trim()
      .split('\n')
      .find((x) => x.trim()) ?? ''
  return out || t('没有输出')
}

/**
 * 输入框上方的「子任务」入口，和子对话同一行、同一个弹层样式：
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

  const steps = ids
    .map((id) => task.steps.find((s) => s.id === id))
    .filter((s): s is TaskStep => !!s)
    .sort((a, b) => helperRank(a) - helperRank(b))
  const running = steps.filter((s) => s.status === 'running')
  const failed = steps.filter((s) => s.status === 'failed')
  const now = useNow(running.length > 0)
  // 角色名：默认的「子任务」角色不用再写一遍，点名派给「测试验收」这类角色时才标出来
  const who = (step: TaskStep) => agents.find((a) => a.id === step.agentId && a.origin !== 'builtin:helper')
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
        <span className="shrink-0 font-medium">{t('子任务 {n}', { n: steps.length })}</span>
        {/* 执行中写成 2/3（分母是子任务总数），没在执行时只显示总数 */}
        {running.length > 0 && (
          <span
            aria-label={t('{n} 个执行中', { n: running.length })}
            className="flex shrink-0 items-center gap-1 pr-1 text-xs text-accent"
          >
            <span className="text-subtle">·</span>
            <Loader2 className="h-3 w-3 animate-spin" />
            {running.length}/{steps.length}
          </span>
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
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setWin(s.id)
                        setOpen(false)
                      }}
                      className="flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sel"
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
                      <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">{helperTime(s, now)}</span>
                    </button>
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
  const live = step?.status === 'running'
  const now = useNow(live)
  // 这个子任务自己的消息（旧数据里它再派出去的也在它名下）
  const msgs = task.messages.filter((m) => m.step === id || m.step.startsWith(`${id}/`))
  const agent = agents.find((a) => a.id === step?.agentId && a.origin !== 'builtin:helper')
  // 打开就停在最新输出（首帧算不完的高度下一帧和布局稳定后再补），之后跟着新内容走；用户往上翻了就不再拽回来
  const scroller = useStickToBottom(id)
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
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-(--content-w) flex-col gap-4 px-4 py-5 md:px-6">
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
                  : t('子任务已结束，结果已交回给派它的对话。这里只能查看')}
          </footer>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
