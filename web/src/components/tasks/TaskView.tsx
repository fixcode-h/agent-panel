import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowUp,
  FlaskConical,
  GitBranch,
  Info,
  Loader2,
  MessageSquareText,
  PanelRight,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import type { Project, Task, TaskMessage } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { AgentMessage } from './Messages'
import { TaskFlow, StepStatusIcon } from './TaskFlow'
import { TaskPanel } from './TaskPanel'
import { TaskStatusIcon } from './TaskStatusIcon'

type Block =
  | { kind: 'msg'; m: TaskMessage }
  | {
      kind: 'stage'
      stage: number
      key: string
      byStep: Map<number, TaskMessage[]>
    }

/** 把消息分段：同一阶段的节点消息归到一起，并行节点的输出不会交错在一起 */
function toBlocks(task: Task): Block[] {
  const blocks: Block[] = []
  for (const m of task.messages) {
    const step = m.role === 'agent' && m.step >= 0 ? task.steps[m.step] : undefined
    if (!step) {
      blocks.push({ kind: 'msg', m })
      continue
    }
    let b = blocks.at(-1)
    if (b?.kind !== 'stage' || b.stage !== step.stage) {
      b = { kind: 'stage', stage: step.stage, key: m.id, byStep: new Map() }
      blocks.push(b)
    }
    const list = b.byStep.get(m.step) ?? []
    list.push(m)
    b.byStep.set(m.step, list)
  }
  return blocks
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-subtle">
      <span className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

function MessageList({ msgs, teamNames }: { msgs: TaskMessage[]; teamNames: Set<string> }) {
  return (
    <>
      {msgs.map((m, k) => {
        const compact = k > 0 && msgs[k - 1].agentId === m.agentId
        return (
          <div key={m.id} className={cn(compact && '-mt-2')}>
            <AgentMessage m={m} teamNames={teamNames} compact={compact} />
          </div>
        )
      })}
    </>
  )
}

function StageBlock({
  task,
  block,
  last,
  teamNames,
}: {
  task: Task
  block: Extract<Block, { kind: 'stage' }>
  last: boolean
  teamNames: Set<string>
}) {
  const { agents } = useData()
  const stageCount = new Set(task.steps.map((s) => s.stage)).size
  const inStage = task.steps.map((s, i) => ({ s, i })).filter((x) => x.s.stage === block.stage)
  // 最后一段里还没输出的并行节点也显示出来
  const shown = inStage.filter((x) => block.byStep.has(x.i) || (last && x.s.status === 'running'))
  const title = task.stages[block.stage]?.title ?? `阶段 ${block.stage + 1}`
  if (inStage.length <= 1)
    return (
      <div className="flex flex-col gap-5">
        <Divider>
          阶段 {block.stage + 1}/{stageCount} · {inStage[0]?.s.title ?? title}
        </Divider>
        <MessageList msgs={[...block.byStep.values()].flat()} teamNames={teamNames} />
      </div>
    )
  return (
    <div className="flex flex-col gap-3">
      <Divider>
        <GitBranch className="h-3.5 w-3.5 rotate-90" />
        阶段 {block.stage + 1}/{stageCount} · {title} · 并行 {inStage.length} 个节点
      </Divider>
      {shown.map(({ s, i }) => {
        const a = agents.find((x) => x.id === s.agentId)
        const msgs = block.byStep.get(i) ?? []
        return (
          <section key={i} className="rounded-xl border bg-panel">
            <header className="flex items-center gap-2 border-b px-3.5 py-2 text-[13px]">
              <StepStatusIcon status={s.status} />
              <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
              <span className="truncate text-xs text-subtle">{a?.name}</span>
            </header>
            <div className="flex flex-col gap-4 px-3.5 py-3.5">
              {msgs.length ? (
                <MessageList msgs={msgs} teamNames={teamNames} />
              ) : (
                <span className="flex items-center gap-2 text-xs text-subtle">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在启动…
                </span>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** 一个任务的对话页：上方是执行输出，下方继续输入要求，右侧是进度、上下文和更改 */
export function TaskView({
  taskId,
  project,
  onChange,
  onDeleted,
}: {
  taskId: string
  project: Project
  onChange: (t: Task) => void
  onDeleted: () => void
}) {
  const { agents, workflows } = useData()
  const [task, setTask] = useState<Task | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [panel, setPanel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [view, setView] = useState<'chat' | 'flow'>('chat')
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const apply = (t: Task) => {
    setTask(t)
    onChange(t)
  }

  useEffect(() => {
    api
      .task(taskId)
      .then(apply)
      .catch((e) => toast.error((e as Error).message))
  }, [taskId])

  // 执行中时轮询；真实执行接入后可以换成服务端推送
  const running = task?.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(
      () =>
        api
          .task(taskId)
          .then(apply)
          .catch(() => {}),
      700,
    )
    return () => clearInterval(t)
  }, [running, taskId])

  // 停留在底部时自动跟随新输出
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && view === 'chat') el.scrollTop = el.scrollHeight
  }, [task, view])

  const workflow = workflows.find((w) => w.id === task?.workflowId)
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])

  if (!task)
    return (
      <main className="flex flex-1 items-center justify-center text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </main>
    )

  const send = async () => {
    if (!text.trim() || running || sending) return
    setSending(true)
    stick.current = true
    try {
      apply(await api.sendMessage(task.id, text))
      setText('')
      // 发送后马上拉一次，让「执行中」尽快出现
      setTimeout(
        () =>
          api
            .task(task.id)
            .then(apply)
            .catch(() => {}),
        200,
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const stop = async () => {
    try {
      await api.stopTask(task.id)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async () => {
    try {
      await api.deleteTask(task.id)
      toast.success('已删除任务')
      onDeleted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const runningSteps = task.steps.filter((s) => s.status === 'running')
  const lastAgent = [...task.messages].reverse().find((m) => m.role === 'agent')
  const busyAgent = agents.find((a) => a.id === (runningSteps[0]?.agentId ?? lastAgent?.agentId))
  const chatAgent = agents.find((a) => a.id === task.agentId)
  const blocks = toBlocks(task)
  const isFlow = task.mode === 'workflow' && view === 'flow'

  return (
    <>
      <div className="relative flex min-h-[70vh] min-w-0 flex-1 md:h-full md:min-h-0">
        <main className="flex min-w-0 flex-1 flex-col md:h-full">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-bg px-4 py-3 md:px-6">
            <TaskStatusIcon status={task.status} />
            <h2 className="min-w-0 flex-[1_1_200px] truncate text-[15px] font-semibold">{task.title}</h2>
            <div className="flex flex-wrap items-center gap-2">
              {task.mode === 'workflow' && (
                <div className="flex rounded-lg bg-field p-0.5 ring-1 ring-line" role="tablist" aria-label="视图">
                  {(
                    [
                      ['chat', '对话', MessageSquareText],
                      ['flow', '流程图', GitBranch],
                    ] as const
                  ).map(([v, label, Icon]) => (
                    <button
                      key={v}
                      role="tab"
                      aria-selected={view === v}
                      onClick={() => {
                        setView(v)
                        stick.current = v === 'chat'
                        if (v === 'flow' && scroller.current) scroller.current.scrollTop = 0
                      }}
                      className={cn(
                        'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium',
                        view === v ? 'bg-card text-fg shadow-card ring-1 ring-line-strong' : 'text-muted hover:text-fg',
                      )}
                    >
                      <Icon className={cn('h-3.5 w-3.5', v === 'flow' && 'rotate-90')} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <Badge>
                {task.mode === 'workflow'
                  ? `工作流 · ${workflow?.name ?? '已删除'}`
                  : `对话 · ${chatAgent?.name ?? '已删除'}`}
              </Badge>
              {task.simulated && (
                <Badge tone="warning" title="还没有真正调用 CLI，输出是示例">
                  <FlaskConical className="h-3 w-3" />
                  模拟执行
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="xl:hidden"
                aria-label="显示任务面板"
                title="任务进度、上下文和更改"
                onClick={() => setPanel(true)}
              >
                <PanelRight className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="删除任务"
                title="删除任务"
                onClick={() => setDeleting(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </header>

          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="flex-1 overflow-y-auto"
          >
            {isFlow ? (
              <TaskFlow
                task={task}
                onOpenChat={() => {
                  stick.current = true
                  setView('chat')
                }}
              />
            ) : (
              <div className="mx-auto flex max-w-[780px] flex-col gap-5 px-4 py-6 md:px-6">
                {blocks.map((b, k) =>
                  b.kind === 'stage' ? (
                    <StageBlock
                      key={b.key}
                      task={task}
                      block={b}
                      last={k === blocks.length - 1}
                      teamNames={teamNames}
                    />
                  ) : b.m.role === 'user' ? (
                    <div
                      key={b.m.id}
                      className="ml-auto max-w-[85%] rounded-2xl rounded-br-md border bg-sel px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
                    >
                      {b.m.text}
                    </div>
                  ) : b.m.role === 'system' ? (
                    <div
                      key={b.m.id}
                      className="flex items-start justify-center gap-1.5 text-center text-xs whitespace-pre-wrap text-subtle"
                    >
                      <Info className="mt-px h-3.5 w-3.5 shrink-0" />
                      {b.m.text}
                    </div>
                  ) : (
                    <AgentMessage key={b.m.id} m={b.m} teamNames={teamNames} />
                  ),
                )}
                {running && (
                  <div className="flex items-center gap-2 text-[13px] text-muted">
                    <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    {runningSteps.length > 1
                      ? `${runningSteps.length} 个节点正在并行执行`
                      : busyAgent
                        ? `${busyAgent.name} 正在执行`
                        : '正在执行'}
                    {runningSteps.length === 1 && <span className="text-subtle">· {runningSteps[0].title}</span>}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="px-4 pt-1 pb-4 md:px-6 md:pb-5">
            <div className="mx-auto max-w-[780px] rounded-2xl border border-line-strong bg-card shadow-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent-soft">
              <label htmlFor="follow-up" className="sr-only">
                继续输入要求
              </label>
              <textarea
                id="follow-up"
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={
                  running ? '执行中，完成后可以继续输入要求' : '继续输入要求，Enter 发送，Shift + Enter 换行'
                }
                className="block max-h-48 w-full resize-none bg-transparent focus-visible:outline-none px-4 pt-3 text-[14px] leading-relaxed outline-none placeholder:text-subtle"
              />
              <div className="flex items-center gap-2 px-3 pb-2.5">
                <span className="truncate text-xs text-subtle">
                  {running
                    ? '执行中，可以随时停止'
                    : task.mode === 'workflow'
                      ? task.steps.every((s) => s.status === 'done')
                        ? `由主 Agent ${agents.find((a) => a.id === workflow?.mainAgentId)?.name ?? ''} 处理追加要求`
                        : task.status === 'failed'
                          ? '会从失败的节点重新执行'
                          : '会从没完成的节点继续执行'
                      : `发给 ${chatAgent?.name ?? 'Agent'}`}
                </span>
                {running ? (
                  <Button size="sm" variant="secondary" className="ml-auto" onClick={stop}>
                    <Square className="h-3.5 w-3.5 fill-current" />
                    停止
                  </Button>
                ) : (
                  <Button
                    size="icon-sm"
                    className="ml-auto"
                    aria-label="发送"
                    disabled={!text.trim() || sending}
                    onClick={send}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </main>

        <aside
          className={cn(
            'w-[320px] shrink-0 flex-col overflow-y-auto border-l bg-panel p-3',
            panel ? 'fixed inset-y-0 right-0 z-40 flex max-w-full shadow-2xl' : 'hidden',
            'xl:static xl:z-auto xl:flex xl:h-full xl:shadow-none',
          )}
        >
          {panel && (
            <div className="mb-2 flex items-center justify-between xl:hidden">
              <span className="px-1 text-[13px] font-semibold">任务面板</span>
              <Button variant="ghost" size="icon-sm" aria-label="关闭面板" onClick={() => setPanel(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          <TaskPanel task={task} project={project} workflow={workflow} />
        </aside>
        {panel && <div className="fixed inset-0 z-30 bg-black/40 xl:hidden" onClick={() => setPanel(false)} />}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除任务「${task.title}」？`}
        description="会删除这个任务的对话记录，不会撤销已经改动的文件。"
        onConfirm={remove}
      />
    </>
  )
}
