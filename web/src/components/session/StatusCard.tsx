import { useEffect, useMemo, useState } from 'react'
import {
  BellRing,
  CircleAlert,
  Clock,
  GitMerge,
  Hourglass,
  Info,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  SquareTerminal,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import type { ChildEntry } from '@shared/task'
import { diagnoseTask, type DiagItem, type DiagTone } from '@shared/task-diagnosis'
import { cn } from '@/lib/utils'
import { TaskStatusIcon } from '@/components/tasks/TaskStatusIcon'
import { SessionCard, SessionRow } from './SessionCard'

const KIND_ICON: Record<DiagItem['kind'], LucideIcon> = {
  child: MessageSquare,
  helper: Users,
  job: SquareTerminal,
  workflow: Workflow,
  ask: MessageCircleQuestion,
  api: Hourglass,
  plan: ListChecks,
  nudge: BellRing,
  branch: GitMerge,
  hint: Info,
}

const TONE: Record<DiagTone, string> = {
  accent: 'text-accent-text',
  warning: 'text-warning',
  danger: 'text-danger',
  subtle: 'text-muted',
  success: 'text-success',
}

/**
 * 会话栏最上面的「状态」：这个对话现在是什么情况、在等什么、为什么停住了（见 shared/task-diagnosis.ts）。
 * 那句话照旧把子对话算进去（「在等 2 个子对话」），但子对话不在这里逐个列：
 * 它们只有一个家，输入框上方的子对话面板（ADR 0034），右栏再列一遍就是两处
 */
export function StatusCard({ task, kids = [] }: { task: Task; kids?: (ChildEntry & { title: string })[] }) {
  // 「已 n 分钟没有新输出」「已运行 3 分钟」要跟着走：半分钟刷一次够了
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const d = useMemo(() => diagnoseTask(task, kids, now), [task, kids, now])
  const items = d.items.filter((x) => x.kind !== 'child')
  return (
    <SessionCard id="status" title={t('状态')}>
      <div className="flex items-start gap-2.5 px-0 py-1" data-diagnosis={d.state}>
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          <HeadIcon state={d.state} task={task} />
        </span>
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-5 break-words text-fg">{d.headline}</p>
      </div>
      {items.length > 0 && (
        <div className="mt-1 flex flex-col">
          {items.map((x, i) => {
            const Icon = KIND_ICON[x.kind]
            return (
              <SessionRow
                key={`${x.kind}-${x.taskId ?? i}`}
                icon={<Icon className={x.kind === 'hint' ? 'text-subtle' : undefined} />}
                title={[x.text, x.detail].filter(Boolean).join('\n')}
                className={cn('min-h-0 py-1', x.kind === 'hint' && 'text-muted')}
              >
                <span className="block truncate">{x.text}</span>
                {x.detail && (
                  <span
                    className={cn(
                      'block truncate text-xs',
                      x.tone === 'danger' || x.tone === 'warning' ? TONE[x.tone] : 'text-muted',
                    )}
                  >
                    {x.detail}
                  </span>
                )}
              </SessionRow>
            )
          })}
        </div>
      )}
    </SessionCard>
  )
}

/** 标题行的图标：停住了（计划没做完、改动没合回）用提醒图标，不画成转圈——它其实没在动 */
function HeadIcon({ state, task }: { state: string; task: Task }) {
  if (state === 'unfinished') return <CircleAlert className="h-4 w-4 text-warning" />
  if (state === 'wrapup') return <Clock className="h-4 w-4 text-success" />
  const icon =
    state === 'running' || state === 'waiting'
      ? 'running'
      : state === 'needs'
        ? 'waiting'
        : state === 'failed'
          ? 'failed'
          : state === 'stopped'
            ? task.stopReason && task.stopReason !== 'user'
              ? 'idle'
              : 'stopped'
            : 'done'
  return <TaskStatusIcon status={task.status} icon={icon} />
}
