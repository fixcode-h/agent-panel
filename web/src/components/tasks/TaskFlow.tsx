import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { StepStatus, Task } from '@shared/schema'
import { END, START, childSteps, entryFlow, getFlow, stepTree, taskWorkflows, topSteps } from '@shared/flow'
import { stepsTokens, tokenCount } from '@shared/run-usage'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import { useNow } from '@/lib/useNow'
import { fmtTokens, stepDuration } from '@/lib/tasks'
import { FlowCanvas, type EdgeTone, type NodeView } from '@/components/flow/FlowCanvas'
import { nodeViews } from '@/components/flow/views'
import { StepSection } from './StepSection'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'

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
  onSelect,
}: {
  task: Task
  /** 外面（右栏的任务进度）要求选中的节点；at 变了就重新选中 */
  focus?: { id: string; at: number }
  onOpenChat: () => void
  /** 选中的节点变了：右栏跟着只看这个节点 */
  onSelect?: (id: string) => void
}) {
  const data = useData()
  const { agents } = data
  // 上面流程图的高度：中间的分界线上下拖，记在本机；流程图至少 180px（放得下缩放按钮和小地图），下面的节点输出至少留 160px
  const box = useRef<HTMLDivElement>(null)
  const graph = usePaneWidth(
    'task-flow-graph',
    () => Math.round(Math.min(320, window.innerHeight * 0.36)),
    180,
    () => (box.current?.clientHeight ?? window.innerHeight) - 160,
  )
  const { modelOf } = useAgentView()
  // 用任务创建时存下的工作流画图，之后改了工作流也和执行记录对得上
  const { workflow, workflows } = taskWorkflows(task, data.workflows)
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const tops = topSteps(task)
  const flow = workflow ? (getFlow(workflow, tops[0]?.flowId ?? '') ?? entryFlow(workflow)) : undefined
  const runningId = tops.find((s) => s.status === 'running')?.id
  // 执行中的节点底部的耗时每秒走一次
  const now = useNow(!!runningId)
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
      // 节点底部：耗时（含之前被打断时做的部分）和 token（输入 + 输出，含节点里各步、挂载流程等所有子节点）
      const tokens = step ? tokenCount(stepsTokens([step, ...stepTree(task, step.id)])) : 0
      out[id] = {
        ...v,
        loose: false,
        status: step?.status ?? 'skipped',
        // 多步节点的每一步按引擎的记录（`<节点>/step/<步骤 id>`）对上状态；还没跑到的没有记录，算计划中
        units: v.units?.map((u) => ({
          ...u,
          status: kids.find((k) => k.slot === 'step' && k.nodeId === u.id)?.status ?? 'pending',
        })),
        stats: step ? { time: stepDuration(step, now), tokens: tokens ? `${fmtTokens(tokens)} tok` : '' } : undefined,
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
  }, [flow, workflow, workflows, agents, task, data.settings, now])

  if (!flow || !workflow)
    return (
      <p className="px-6 py-10 text-center text-body text-subtle">{t('这个任务的工作流已经删除，无法显示流程图。')}</p>
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
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex shrink-0 border-b" style={{ height: graph.width }}>
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
          className="flex min-w-0 flex-1 bg-panel"
        />
        <ResizeHandle pane={graph} side="bottom" label={t('拖动调整流程图的高度')} />
      </div>
      {step && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            <div className="mx-auto flex w-full max-w-(--content-w) flex-col gap-4 px-4 pb-6 md:px-6">
              <StepSection task={task} rootId={step.id} msgs={msgs} teamNames={teamNames} sticky="flow" />
              {!msgs.length && step.status !== 'running' && (
                <p className="text-body text-subtle">
                  {step.status === 'pending'
                    ? t('这个节点还没开始执行。')
                    : step.status === 'skipped'
                      ? t('没有执行。')
                      : t('没有输出。')}
                </p>
              )}
              <Button variant="link" onClick={onOpenChat} className="self-start text-xs">
                <MessageSquareText className="h-3.5 w-3.5" />
                {t('在对话中查看完整过程')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
