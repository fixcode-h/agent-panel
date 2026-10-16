import { useEffect, useMemo, useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { StepStatus, Task } from '@shared/schema'
import { END, START, childSteps, entryFlow, getFlow } from '@shared/flow'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import { FlowCanvas, type EdgeTone, type NodeView } from '@/components/flow/FlowCanvas'
import { nodeViews } from '@/components/flow/views'
import { StepSection } from './StepSection'

/** 一组子节点合起来的状态 */
function combined(list: StepStatus[]): StepStatus | undefined {
  if (!list.length) return undefined
  if (list.includes('failed')) return 'failed'
  if (list.includes('running')) return 'running'
  if (list.every((s) => s === 'done' || s === 'skipped')) return 'done'
  return 'pending'
}

/** 任务的流程图：主流程的节点显示执行状态，挂载的流程显示轮次和结论；点节点在下面看它的输出 */
export function TaskFlow({ task, onOpenChat }: { task: Task; onOpenChat: () => void }) {
  const { workflows, agents } = useData()
  const { modelOf } = useAgentView()
  const workflow = workflows.find((w) => w.id === task.workflowId)
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const tops = task.steps.filter((s) => !s.parentId)
  const flow = workflow ? (getFlow(workflow, tops[0]?.flowId ?? '') ?? entryFlow(workflow)) : undefined
  const runningId = tops.find((s) => s.status === 'running')?.id
  const [sel, setSel] = useState(() => runningId ?? tops.find((s) => s.status === 'failed')?.id ?? tops[0]?.id ?? '')
  const [follow, setFollow] = useState(true)
  useEffect(() => {
    if (follow && runningId) setSel(runningId)
  }, [follow, runningId])

  const views = useMemo(() => {
    if (!flow || !workflow) return {}
    const base = nodeViews(flow, workflow, workflows, agents, modelOf)
    const out: Record<string, NodeView> = {}
    for (const [id, v] of Object.entries(base)) {
      const step = tops.find((s) => s.id === id)
      const kids = step ? childSteps(task, step.id) : []
      out[id] = {
        ...v,
        loose: false,
        status: step?.status ?? 'skipped',
        hooks: v.hooks.map((h) => {
          const mine = kids.filter((k) => k.slot === h.slot)
          const last = Math.max(0, ...mine.map((k) => k.round))
          const cur = h.slot === 'review' ? mine.filter((k) => k.round === last) : mine
          return {
            ...h,
            status: combined(cur.map((k) => k.status)),
            extra:
              h.slot === 'review' && step?.rounds
                ? `${step.rounds} 轮 · ${step.verdict === 'fail' ? '未通过' : '通过'}`
                : h.slot === 'review' && last
                  ? `第 ${last} 轮`
                  : (h.extra ?? undefined),
          }
        }),
      }
    }
    return out
  }, [flow, workflow, workflows, agents, task])

  if (!flow || !workflow)
    return <p className="px-6 py-10 text-center text-[13px] text-subtle">这个任务的工作流已经删除，无法显示流程图。</p>

  const status = (id: string) => (id === START ? 'done' : tops.find((s) => s.id === id)?.status)
  const allDone = tops.length > 0 && tops.every((s) => s.status === 'done')
  const edgeTone = (from: string, to: string): EdgeTone => {
    const a = status(from)
    if (to === END) return a === 'done' && allDone ? 'done' : 'idle'
    const b = status(to)
    if (b === 'running') return 'active'
    if (b === 'done' && a === 'done') return 'done'
    return 'idle'
  }

  const step = tops.find((s) => s.id === sel)
  const msgs = step
    ? task.messages.filter((m) => m.role !== 'user' && (m.step === step.id || m.step.startsWith(step.id + '/')))
    : []

  return (
    <div className="flex flex-col">
      <FlowCanvas
        flow={flow}
        views={views}
        startSub="任务开始"
        terms={{ start: 'done', end: allDone ? 'done' : undefined }}
        selected={sel}
        onSelect={(id) => {
          if (!id || id === START || id === END) return
          setSel(id)
          setFollow(false)
        }}
        edgeTone={edgeTone}
        className="flex h-[min(440px,55vh)] border-b bg-panel"
      />
      {step && (
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-4 px-4 py-6 md:px-6">
          <StepSection task={task} rootId={step.id} msgs={msgs} teamNames={teamNames} />
          {!msgs.length && step.status !== 'running' && (
            <p className="text-[13px] text-subtle">
              {step.status === 'pending'
                ? '这个节点还没开始执行。'
                : step.status === 'skipped'
                  ? '没有执行。'
                  : '没有输出。'}
            </p>
          )}
          <button
            onClick={onOpenChat}
            className="flex cursor-pointer items-center gap-1 self-start text-xs text-accent hover:underline"
          >
            <MessageSquareText className="h-3.5 w-3.5" />
            在对话中查看完整过程
          </button>
        </div>
      )}
    </div>
  )
}
