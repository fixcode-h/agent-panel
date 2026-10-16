import { Loader2, Workflow as WorkflowIcon } from 'lucide-react'
import type { Task, TaskMessage } from '@shared/schema'
import { parseVerdict } from '@shared/engine'
import { useData } from '@/lib/data'
import { stepDuration, stepLabel, verdictText } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { FoldedRun, SystemNote } from './Messages'
import { LiveStats } from './LiveStats'
import { StepIcon } from './TaskStatusIcon'

export { SystemNote }

/** 这个节点（含子节点）里正在执行的 Agent */
function running(task: Task, rootId: string) {
  return task.steps
    .filter((s) => s.status === 'running' && (s.id === rootId || s.id.startsWith(rootId + '/')))
    .map((s) => s.agentId)
}

/** 连续属于同一个节点的消息归成一段 */
function runs(msgs: TaskMessage[]) {
  const out: { step: string; msgs: TaskMessage[] }[] = []
  for (const m of msgs) {
    const last = out.at(-1)
    if (last && last.step === m.step) last.msgs.push(m)
    else out.push({ step: m.step, msgs: [m] })
  }
  return out
}

/**
 * 一个主流程节点的输出：节点自己的消息，以及开始、验收、结束流程里各节点的消息（缩进显示）。
 * 验收不通过后节点继续修改的输出按时间顺序接在验收后面。
 */
export function StepSection({
  task,
  rootId,
  msgs,
  teamNames,
  bare,
}: {
  task: Task
  rootId: string
  msgs: TaskMessage[]
  teamNames: Set<string>
  /** 不显示节点标题（外面已经有了） */
  bare?: boolean
}) {
  const { agents } = useData()
  const now = useNow(task.status === 'running')
  const root = task.steps.find((s) => s.id === rootId)
  if (!root) return <FoldedRun msgs={msgs} teamNames={teamNames} />
  const a = agents.find((x) => x.id === root.agentId)
  const time = stepDuration(root, now)
  const vt = verdictText(root)

  return (
    <section className="flex flex-col gap-3">
      {!bare && (
        <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <StepIcon status={root.status} />
          <span className="min-w-0 truncate text-[14px] font-semibold">{root.title}</span>
          <span className="flex items-center gap-1.5 text-xs text-subtle">
            {root.kind === 'flow' ? (
              <>
                <WorkflowIcon className="h-3.5 w-3.5" />
                调用流程
              </>
            ) : (
              a && (
                <>
                  <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                  {a.name}
                </>
              )
            )}
          </span>
          {vt && (
            <span
              className={cn(
                'rounded-full px-2 py-px text-[11px]',
                root.verdict === 'fail' ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success',
              )}
            >
              {vt}
            </span>
          )}
          {time && <span className="ml-auto font-mono text-[11px] text-subtle">{time}</span>}
        </header>
      )}
      <div className={cn('flex flex-col gap-4', !bare && 'ml-[7px] border-l pl-5')}>
        {runs(msgs).map((r, i) => {
          if (r.step === rootId)
            return <FoldedRun key={i} msgs={r.msgs} teamNames={teamNames} live={root.status === 'running'} />
          const s = task.steps.find((x) => x.id === r.step)
          const v =
            s?.slot === 'review'
              ? parseVerdict(
                  r.msgs
                    .filter((m) => m.role === 'agent')
                    .map((m) => m.text)
                    .join('\n'),
                )
              : null
          return (
            <div key={i} className="flex flex-col gap-3 rounded-xl border bg-panel px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {s && <StepIcon status={s.status} className="h-3.5 w-3.5" />}
                <span className="min-w-0 truncate font-medium text-muted">{s ? stepLabel(s) : '子流程'}</span>
                {v && (
                  <span
                    className={cn(
                      'ml-auto rounded-full px-2 py-px text-[11px]',
                      v === 'fail' ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success',
                    )}
                  >
                    {v === 'fail' ? '不通过' : '通过'}
                  </span>
                )}
              </div>
              <FoldedRun msgs={r.msgs} teamNames={teamNames} live={s?.status === 'running'} />
            </div>
          )
        })}
        {root.status === 'running' && (
          <span className="flex items-center gap-2 text-xs text-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            {msgs.length ? '执行中…' : '正在启动…'}
            <LiveStats task={task} agentIds={running(task, rootId)} />
          </span>
        )}
      </div>
    </section>
  )
}
