import { memo, useEffect, useState, type ReactNode } from 'react'
import * as D from '@radix-ui/react-dialog'
import { ChevronRight, CircleCheck, CircleX, Loader2, Workflow as WorkflowIcon, X } from 'lucide-react'
import type { Task, ToolUse } from '@shared/schema'
import { stepMs } from '@shared/task'
import { topSteps } from '@shared/flow'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { useTaskStream } from '@/lib/task-stream'
import { fmtDuration, startedRun } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { Modal } from '@/components/ui/modal'
import { FlowStrip, type FlowNode } from '@/components/ui/flow-strip'
import { StepIcon } from './TaskStatusIcon'
import { StepSection } from './StepSection'
import { t } from '@shared/i18n'

/** 一次运行的状态：有失败的算失败，还在跑的算执行中，全做完算完成。运行面板和子对话里的运行视图共用 */
export function runState(task: Task, run: number) {
  const steps = topSteps(task, run)
  if (steps.some((s) => s.status === 'failed')) return 'failed' as const
  if (steps.some((s) => s.status === 'running')) return 'running' as const
  if (steps.length && steps.every((s) => s.status === 'done' || s.status === 'skipped')) return 'done' as const
  return 'waiting' as const
}

/** 这张卡片用到的内容：节点状态、结论和时间变了才需要重画 */
const runSig = (task: Task, run: number) =>
  `${task.status}|${topSteps(task, run)
    .map((s) => `${s.id}:${s.status}:${s.verdict}:${s.endedAt}:${s.title}`)
    .join(',')}`

/** 这次运行花的工夫：各个节点的执行时间相加 */
function runDuration(task: Task, run: number, now: number) {
  const ms = topSteps(task, run).reduce((n, s) => n + stepMs(s, now), 0)
  return ms >= 1000 ? fmtDuration(ms) : ''
}

/**
 * 主 Agent 对话流里代表一次工作流运行的卡片：节点输出不直接铺在对话里，
 * 点开在右边按节点看这一次运行的对话
 */
function RunCardBase({
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
  // 组件库「计划 · 工作流」：浅底卡片，头一行写工作流和进度，下面一排节点胶囊（完成绿、运行中强调、没开始灰）
  const nodes: FlowNode[] = steps.map((s) => ({
    id: s.id,
    label: s.title || t('未命名'),
    state:
      s.status === 'done' ? 'done' : s.status === 'running' ? 'running' : s.status === 'failed' ? 'failed' : 'idle',
  }))
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('打开这次运行的对话')}
      data-run={run}
      className="group flex w-full cursor-pointer flex-col gap-2.5 rounded-xl bg-sel/45 px-3 py-2.5 text-left transition-colors hover:bg-sel/70"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-[0.8125rem]">
        {state === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
        ) : state === 'done' ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : state === 'failed' ? (
          <CircleX className="h-3.5 w-3.5 shrink-0 text-danger" />
        ) : (
          <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <span className="shrink-0 font-semibold">{t('运行 {n}', { n: run })}</span>
        {name && <span className="min-w-0 truncate text-muted">{name}</span>}
        <span className="flex-1" />
        {time && <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">{time}</span>}
        {steps.length > 0 && (
          <span className="flex h-6 shrink-0 items-center gap-0.5 rounded-md bg-card px-2 text-xs font-medium text-fg tabular-nums">
            {t('{done}/{total} 个节点', { done, total: steps.length })}
            <ChevronRight className="h-3.5 w-3.5 text-subtle transition-transform group-hover:translate-x-0.5" />
          </span>
        )}
      </span>
      {nodes.length > 0 && <FlowStrip nodes={nodes} />}
    </button>
  )
}

export const RunCard = memo(
  RunCardBase,
  (a, b) => a.run === b.run && a.name === b.name && runSig(a.task, a.run) === runSig(b.task, b.run),
)

/**
 * 这一次运行的内容：主流程每个节点的输出按时间顺排下来，还没开始的节点也列出来，
 * 能看出这次运行还有哪些事。右边面板和对话里打开的窗口用的是同一份，观感和主对话流一致
 */
export function RunFlow({ task, run }: { task: Task; run: number }) {
  const { agents } = useData()
  const teamNames = new Set(agents.map((a) => a.name))
  const steps = topSteps(task, run)
  // 和对话窗口一样：打开时停在最新的输出，停在底部时跟着新输出走，往上翻看时不打扰；换看另一次运行时回到最新输出
  const scroller = useStickToBottom(run, 80)
  return (
    <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
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
          return <StepSection key={s.id} task={task} rootId={s.id} msgs={msgs} teamNames={teamNames} sticky="flow" />
        })}
        {!steps.length && <p className="text-[0.8125rem] text-subtle">{t('这次运行还没有节点。')}</p>}
      </div>
    </div>
  )
}

/**
 * 右边打开的这一次运行：占文件面板那一栏，沿用它的宽度和拖动条
 */
export function RunPanel({
  task,
  run,
  name,
  onClose,
  footer,
}: {
  task: Task
  run: number
  name?: string
  onClose: () => void
  /** 输入框：跟着这次运行放在底下，不用关掉面板再回到对话里写 */
  footer?: ReactNode
}) {
  const state = runState(task, run)
  useEscape(true, onClose)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <WorkflowIcon className="h-4 w-4 shrink-0 text-muted" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[0.875rem] font-medium">{t('运行 {n}', { n: run })}</span>
          {name && <span className="truncate text-xs text-subtle">{name}</span>}
          {state === 'running' && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-accent-text">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('执行中')}
            </span>
          )}
        </span>
        <IconButton size="sm" icon={X} label={t('关闭')} onClick={onClose} />
      </header>
      <RunFlow task={task} run={run} />
      {footer && <div className="shrink-0 border-t bg-bg px-3 py-3 md:px-4">{footer}</div>}
    </div>
  )
}

/**
 * 对话里的「启动工作流」一行点开的窗口：内容和右边这次运行的面板一样（按节点铺开 Agent 的消息、
 * 思考和工具行），但开成窗口，看完关掉就回到对话，不用先挪到右栏
 */
export function RunDialog({
  taskId,
  tool,
  open,
  onOpenChange,
}: {
  taskId: string
  /** 这次调用的工具行：用它认回启动的是第几次运行 */
  tool: ToolUse
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // 工具行拿到的是消息渲染时的任务快照（只有 id）：窗口自己取一次最新的，再跟着推送实时更新
  const [task, setTask] = useState<Task | null>(null)
  useEffect(() => {
    let live = true
    setTask(null)
    api
      .task(taskId)
      .then((t) => {
        if (live) setTask(t)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [taskId])
  useTaskStream(taskId, task?.status === 'running', setTask)

  const run = task ? startedRun(task, tool) : undefined
  const name = run ? task?.runs?.find((r) => r.id === run)?.workflowName || task?.workflowName : ''
  const state = task && run ? runState(task, run) : 'waiting'
  const text = (tool.output ?? '').replace(/\s+$/, '')
  const heading = run ? t('运行 {n}', { n: run }) : t('启动工作流')
  return (
    // 和命令行、差异窗口一样用铺满的查看窗口：只看不填，点到外面就关
    <Modal open={open} onOpenChange={onOpenChange} title={null} size="full" bare closeOnOutside className="bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <WorkflowIcon className="h-4 w-4 shrink-0 text-muted" />
        <D.Title className="flex min-w-0 flex-1 items-center gap-2 text-[0.875rem] font-medium">
          <span className="truncate">{heading}</span>
          {name && <span className="truncate text-xs font-normal text-subtle">{name}</span>}
          {state === 'running' && (
            <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('执行中')}
            </span>
          )}
        </D.Title>
        <D.Close asChild>
          <IconButton size="sm" icon={X} label={t('关闭')} />
        </D.Close>
      </header>
      {task === null ? (
        <p className="mx-auto flex w-full max-w-(--content-w) items-center gap-2 px-4 py-5 text-[0.8125rem] text-subtle md:px-6">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('正在读取这次运行…')}
        </p>
      ) : run ? (
        <RunFlow task={task} run={run} />
      ) : (
        // 没有运行可看（调用失败、还没开始执行）：把原因和这次的输出照原样留着，不换成一句「没有内容」
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-(--content-w) px-4 py-5 md:px-6">
            <p className="mb-2 text-[0.8125rem] text-subtle">{t('这次调用没有启动运行。')}</p>
            {text && (
              <pre
                className={cn(
                  'font-mono text-[0.75rem] leading-[1.65] whitespace-pre-wrap [overflow-wrap:anywhere]',
                  tool.failed ? 'text-danger' : 'text-fg/90',
                )}
              >
                {text}
              </pre>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
