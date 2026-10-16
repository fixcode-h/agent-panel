import { useEffect, useMemo, useState } from 'react'
import {
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  Flag,
  Loader2,
  MessageSquareText,
  PencilLine,
  Play,
  Wrench,
} from 'lucide-react'
import type { Task, TaskStep } from '@shared/schema'
import { taskStages } from '@shared/flow'
import { useData } from '@/lib/data'
import { currentActivity, plainLine, stepActivity, stepDuration } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { Pipeline, type EdgeTone, type PipelineColumn } from '@/components/flow/Pipeline'
import { AgentMessage } from './Messages'
import { useAgentView } from '@/lib/agent-view'

type Status = TaskStep['status']

export function StepStatusIcon({ status, className }: { status: Status; className?: string }) {
  const c = cn('h-4 w-4 shrink-0', className)
  if (status === 'done') return <CircleCheck className={cn(c, 'text-success')} aria-label="已完成" />
  if (status === 'running') return <Loader2 className={cn(c, 'animate-spin text-accent')} aria-label="执行中" />
  if (status === 'failed') return <CircleX className={cn(c, 'text-danger')} aria-label="失败" />
  return <Circle className={cn(c, 'text-subtle')} aria-label="等待中" />
}

const cardTone: Record<Status, string> = {
  done: 'border-line-strong',
  running: 'border-accent shadow-[0_0_0_3px_var(--accent-soft)]',
  failed: 'border-danger/70',
  pending: 'border-dashed border-line-strong',
  skipped: 'border-dashed border-line-strong',
}

function StepCard({
  task,
  step,
  i,
  now,
  selected,
  onSelect,
}: {
  task: Task
  step: TaskStep
  i: number
  now: number
  selected: boolean
  onSelect: () => void
}) {
  const { modelOf } = useAgentView()
  const { agents } = useData()
  const a = agents.find((x) => x.id === step.agentId)
  const act = stepActivity(task, i)
  const time = stepDuration(step, now)
  const line =
    step.status === 'running'
      ? currentActivity(act)
      : step.status === 'done'
        ? plainLine(act.text) || '已完成'
        : step.status === 'failed'
          ? '执行失败，点开查看原因'
          : task.status === 'running'
            ? '等待前面的阶段完成'
            : '还没有执行'
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-[box-shadow,border-color] hover:border-accent/60',
        cardTone[step.status],
        selected && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
        step.status === 'pending' && 'bg-card/60',
      )}
    >
      <span className="flex items-start gap-2">
        <StepStatusIcon status={step.status} className="mt-px" />
        <span
          className={cn(
            'min-w-0 flex-1 text-[13px] leading-snug font-medium',
            step.status === 'pending' && 'text-muted',
          )}
        >
          {step.title}
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-xs text-muted">
        {a ? <AgentAvatar icon={a.icon} cli={a.cli} size="xs" dim={step.status === 'pending'} /> : null}
        <span className="truncate">{a?.name ?? '已删除的 Agent'}</span>
        {a && <span className="truncate font-mono text-[11px] text-subtle">{modelOf(a)}</span>}
      </span>
      <span
        className={cn(
          'line-clamp-2 text-xs leading-relaxed [overflow-wrap:anywhere]',
          step.status === 'running' ? 'text-fg' : step.status === 'failed' ? 'text-danger' : 'text-subtle',
        )}
      >
        {line}
      </span>
      {(act.tools > 0 || time) && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px] text-subtle">
          {act.tools > 0 && (
            <span className="flex items-center gap-1" title="读文件、改文件、运行命令等操作次数">
              <Wrench className="h-3 w-3" />
              {act.tools} 次操作
            </span>
          )}
          {act.files > 0 && (
            <span className="flex items-center gap-1">
              <PencilLine className="h-3 w-3" />
              {act.files} 个文件
            </span>
          )}
          {time && (
            <span className="ml-auto flex items-center gap-1 font-mono">
              <Clock className="h-3 w-3" />
              {time}
            </span>
          )}
        </span>
      )}
    </button>
  )
}

function Terminal({
  icon: Icon,
  label,
  sub,
  tone,
}: {
  icon: typeof Play
  label: string
  sub: string
  tone: 'done' | 'idle' | 'active'
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border bg-card py-1.5 pr-3.5 pl-1.5">
      <span
        className={cn(
          'grid h-7 w-7 shrink-0 place-items-center rounded-full',
          tone === 'done'
            ? 'bg-success/15 text-success'
            : tone === 'active'
              ? 'bg-accent-soft text-accent'
              : 'bg-field text-subtle',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="truncate text-[11px] text-subtle">{sub}</span>
      </span>
    </div>
  )
}

/** 任务的流程图：阶段从左到右，阶段里并行的节点竖着排；点节点在下面看它的输出 */
export function TaskFlow({ task, onOpenChat }: { task: Task; onOpenChat: () => void }) {
  const stages = useMemo(() => taskStages(task), [task])
  const now = useNow(task.status === 'running')
  const { agents } = useData()
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const pick = () =>
    task.steps.findIndex((s) => s.status === 'running') >= 0
      ? task.steps.findIndex((s) => s.status === 'running')
      : task.steps.findIndex((s) => s.status === 'failed') >= 0
        ? task.steps.findIndex((s) => s.status === 'failed')
        : Math.max(0, task.steps.map((s) => s.status).lastIndexOf('done'))
  const [sel, setSel] = useState<number>(pick)
  const [follow, setFollow] = useState(true)
  // 没手动选过时跟着正在执行的节点走
  useEffect(() => {
    if (follow) setSel(pick())
  }, [task, follow])

  const allDone = task.steps.length > 0 && task.steps.every((s) => s.status === 'done')
  const columns: PipelineColumn[] = [
    {
      key: 'start',
      width: 168,
      header: <div className="h-[34px]" />,
      items: [
        {
          key: 'start',
          node: (
            <Terminal
              icon={Play}
              label="开始"
              sub={task.messages.find((m) => m.role === 'user')?.text ?? ''}
              tone="done"
            />
          ),
        },
      ],
    },
    ...stages.map((st, si) => {
      const done = st.steps.filter((x) => x.step.status === 'done').length
      const running = st.steps.some((x) => x.step.status === 'running')
      const failed = st.steps.some((x) => x.step.status === 'failed')
      return {
        key: `s${st.index}`,
        header: (
          <div className="flex h-[34px] items-center gap-2 border-b pb-2">
            <span
              className={cn(
                'grid h-5 min-w-5 place-items-center rounded-md px-1 font-mono text-[11px] font-semibold',
                failed
                  ? 'bg-danger/15 text-danger'
                  : done === st.steps.length
                    ? 'bg-success/15 text-success'
                    : running
                      ? 'bg-accent-soft text-accent'
                      : 'bg-field text-subtle ring-1 ring-line',
              )}
            >
              {si + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{st.title}</span>
            <span className="shrink-0 text-xs text-subtle">
              {st.steps.length > 1 ? `并行 ${done}/${st.steps.length}` : done ? '完成' : running ? '执行中' : ''}
            </span>
          </div>
        ),
        items: st.steps.map(({ step, i }) => ({
          key: step.id,
          node: (
            <StepCard
              task={task}
              step={step}
              i={i}
              now={now}
              selected={sel === i}
              onSelect={() => {
                setSel(i)
                setFollow(false)
              }}
            />
          ),
        })),
      }
    }),
    {
      key: 'end',
      width: 150,
      header: <div className="h-[34px]" />,
      items: [
        {
          key: 'end',
          node: (
            <Terminal
              icon={Flag}
              label="完成"
              sub={
                allDone
                  ? '全部节点已完成'
                  : `${task.steps.filter((s) => s.status === 'done').length}/${task.steps.length} 个节点`
              }
              tone={allDone ? 'done' : 'idle'}
            />
          ),
        },
      ],
    },
  ]

  const status = (key: string): Status | 'start' | 'end' =>
    key === 'start' ? 'start' : key === 'end' ? 'end' : (task.steps.find((s) => s.id === key)?.status ?? 'pending')
  const edgeTone = (from: string, to: string): EdgeTone => {
    const a = status(from)
    const b = status(to)
    if (b === 'end') return a === 'done' ? (allDone ? 'done' : 'idle') : 'idle'
    if (b === 'running') return 'active'
    if (b === 'failed') return 'failed'
    if (b === 'done' && (a === 'done' || a === 'start')) return 'done'
    return 'idle'
  }

  const step = task.steps[sel]
  const act = step ? stepActivity(task, sel) : null
  const agent = agents.find((a) => a.id === step?.agentId)

  return (
    <div className="flex flex-col gap-5 px-4 py-6 md:px-6">
      <Pipeline
        columns={columns}
        edgeTone={edgeTone}
        focus={task.steps[sel]?.id}
        className="rounded-2xl border bg-panel p-4 [background-image:radial-gradient(var(--line)_1px,transparent_1px)] [background-size:16px_16px]"
      />

      {step && act && (
        <section className="mx-auto w-full max-w-[780px] rounded-2xl border bg-card">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
            <StepStatusIcon status={step.status} />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{step.title}</span>
            <span className="flex items-center gap-1.5 text-xs text-muted">
              {agent && <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />}
              {agent?.name}
              <span className="text-subtle">· {task.stages[step.stage]?.title ?? `阶段 ${step.stage + 1}`}</span>
            </span>
            <button
              onClick={onOpenChat}
              className="flex cursor-pointer items-center gap-1 text-xs text-accent hover:underline"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              在对话中查看
            </button>
          </header>
          <div className="flex max-h-[520px] flex-col gap-4 overflow-y-auto px-4 py-4">
            {act.msgs.length ? (
              act.msgs.map((m, k) => <AgentMessage key={m.id} m={m} teamNames={teamNames} compact={k > 0} />)
            ) : (
              <p className="text-[13px] text-subtle">
                {step.status === 'pending'
                  ? '这个节点还没开始执行。'
                  : step.status === 'running'
                    ? '正在启动…'
                    : '没有输出。'}
              </p>
            )}
            {step.status === 'failed' && (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger whitespace-pre-wrap">
                {[...task.messages].reverse().find((m) => m.role === 'system')?.text ?? '执行失败'}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
