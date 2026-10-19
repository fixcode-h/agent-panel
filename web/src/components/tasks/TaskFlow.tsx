import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { StepStatus, Task } from '@shared/schema'
import { END, START, childSteps, entryFlow, getFlow, taskWorkflows, topSteps } from '@shared/flow'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import { FlowCanvas, type EdgeTone, type NodeView } from '@/components/flow/FlowCanvas'
import { nodeViews } from '@/components/flow/views'
import { StepSection } from './StepSection'
import { t } from '@shared/i18n'

/** 一组子节点合起来的状态 */
function combined(list: StepStatus[]): StepStatus | undefined {
  if (!list.length) return undefined
  if (list.includes('failed')) return 'failed'
  if (list.includes('running')) return 'running'
  if (list.every((s) => s === 'done' || s === 'skipped')) return 'done'
  return 'pending'
}

/** 任务的流程图：主流程的节点显示执行状态，挂载的流程显示轮次和结论；点节点在下面看它的输出 */
export function TaskFlow({
  task,
  focus,
  onOpenChat,
  gutter,
  onSelect,
}: {
  task: Task
  /** 放在节点输出左边空白处的内容（任务进度），宽度够时才有 */
  gutter?: React.ReactNode
  /** 外面（右栏的任务进度）要求选中的节点；at 变了就重新选中 */
  focus?: { id: string; at: number }
  onOpenChat: () => void
  /** 选中的节点变了：右栏跟着只看这个节点 */
  onSelect?: (id: string) => void
}) {
  const data = useData()
  const { agents } = data
  const { modelOf } = useAgentView()
  // 用任务创建时存下的工作流画图，之后改了工作流也和执行记录对得上
  const { workflow, workflows } = taskWorkflows(task, data.workflows)
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const tops = topSteps(task)
  const flow = workflow ? (getFlow(workflow, tops[0]?.flowId ?? '') ?? entryFlow(workflow)) : undefined
  const runningId = tops.find((s) => s.status === 'running')?.id
  const [sel, setSel] = useState(() => runningId ?? tops.find((s) => s.status === 'failed')?.id ?? tops[0]?.id ?? '')
  const [follow, setFollow] = useState(true)
  useEffect(() => {
    if (follow && runningId) setSel(runningId)
  }, [follow, runningId])
  useEffect(() => {
    onSelect?.(sel)
    // 只在选中的节点变化时通知；onSelect 每次渲染都是新函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])
  useEffect(() => {
    if (!focus) return
    setSel(focus.id)
    setFollow(false)
    // 每次点「定位」（focus.at 变化）才跳过去
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at])
  // 下面的输出跟着最新内容滚动；往上翻看时不打扰，翻回底部又继续跟随
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    stick.current = true
  }, [sel])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

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
                ? step.verdict === 'fail'
                  ? t('{n} 轮 · 未通过', { n: step.rounds })
                  : t('{n} 轮 · 通过', { n: step.rounds })
                : h.slot === 'review' && last
                  ? t('第 {n} 轮', { n: last })
                  : (h.extra ?? undefined),
          }
        }),
      }
    }
    return out
    // tops 由 task 算出来，modelOf 由设置决定：依赖写 task 和 settings，设置里换了模型节点上也跟着变
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, workflow, workflows, agents, task, data.settings])

  if (!flow || !workflow)
    return (
      <p className="px-6 py-10 text-center text-[13px] text-subtle">
        {t('这个任务的工作流已经删除，无法显示流程图。')}
      </p>
    )

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
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowCanvas
        flow={flow}
        views={views}
        startSub={t('任务开始')}
        terms={{ start: 'done', end: allDone ? 'done' : undefined }}
        selected={sel}
        onSelect={(id) => {
          if (!id || id === START || id === END) return
          setSel(id)
          setFollow(false)
        }}
        edgeTone={edgeTone}
        className="flex h-[min(440px,50vh)] shrink-0 border-b bg-panel"
      />
      {step && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {gutter}
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto flex w-full max-w-(--content-w) flex-col gap-4 px-4 pb-6 md:px-6">
              <StepSection task={task} rootId={step.id} msgs={msgs} teamNames={teamNames} sticky="flow" />
              {!msgs.length && step.status !== 'running' && (
                <p className="text-[13px] text-subtle">
                  {step.status === 'pending'
                    ? t('这个节点还没开始执行。')
                    : step.status === 'skipped'
                      ? t('没有执行。')
                      : t('没有输出。')}
                </p>
              )}
              <button
                onClick={onOpenChat}
                className="flex cursor-pointer items-center gap-1 self-start text-xs text-accent hover:underline"
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                {t('在对话中查看完整过程')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
