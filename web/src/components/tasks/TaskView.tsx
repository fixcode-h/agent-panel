import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowUp,
  FileText,
  FlaskConical,
  Info,
  Loader2,
  PanelRight,
  PencilLine,
  Search,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import type { Project, Task, TaskMessage, ToolUse } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { renderDoc } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { TaskPanel } from './TaskPanel'
import { TaskStatusIcon } from './TaskStatusIcon'

const toolIcon = { read: FileText, edit: PencilLine, run: Terminal, search: Search, other: Wrench }

function ToolRow({ tool }: { tool: ToolUse }) {
  const Icon = toolIcon[tool.kind]
  const diff = tool.kind === 'edit' ? tool.detail.match(/^(\+\d+)?\s*(-\d+)?$/) : null
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-field px-2.5 py-1.5 font-mono text-xs text-muted">
      <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
      <span className="min-w-0 flex-1 truncate">{tool.label}</span>
      {diff ? (
        <span className="shrink-0">
          {diff[1] && <span className="text-success">{diff[1]}</span>} {diff[2] && <span className="text-danger">{diff[2]}</span>}
        </span>
      ) : (
        tool.detail && <span className="shrink-0 text-subtle">{tool.detail}</span>
      )}
    </div>
  )
}

function AgentMessage({ m, teamNames, compact }: { m: TaskMessage; teamNames: Set<string>; compact?: boolean }) {
  const { agents } = useData()
  const a = agents.find((x) => x.id === m.agentId)
  const html = useMemo(() => renderDoc(m.text, teamNames), [m.text, teamNames])
  return (
    <div className="flex gap-3">
      {compact ? (
        <span className="w-[26px] shrink-0" />
      ) : a ? (
        <AgentAvatar icon={a.icon} cli={a.cli} size="sm" />
      ) : (
        <span className="h-[26px] w-[26px] shrink-0 rounded-[7px] bg-field" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {!compact && (
          <div className="flex items-center gap-2 pt-0.5 text-[13px]">
            <span className="font-medium">{a?.name ?? '已删除的 Agent'}</span>
            {a?.model && <span className="font-mono text-xs text-subtle">{a.model}</span>}
          </div>
        )}
        {m.tools.length > 0 && (
          <div className="flex flex-col gap-1">
            {m.tools.map((t, i) => (
              <ToolRow key={i} tool={t} />
            ))}
          </div>
        )}
        {m.text && <div className="chat-md [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
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
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [task])

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

  const runningStep = task.steps.find((s) => s.status === 'running')
  const lastAgent = [...task.messages].reverse().find((m) => m.role === 'agent')
  const busyAgent = agents.find((a) => a.id === (runningStep?.agentId ?? lastAgent?.agentId))
  const chatAgent = agents.find((a) => a.id === task.agentId)
  let prevStep = -1
  // 同一个 Agent 在同一步里连续的消息只显示一次头像和名字
  let prevSpeaker = ''

  return (
    <>
      <div className="relative flex min-h-[70vh] min-w-0 flex-1 md:h-full md:min-h-0">
        <main className="flex min-w-0 flex-1 flex-col md:h-full">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-bg px-4 py-3 md:px-6">
            <TaskStatusIcon status={task.status} />
            <h2 className="min-w-0 flex-[1_1_200px] truncate text-[15px] font-semibold">{task.title}</h2>
            <div className="flex items-center gap-2">
              <Badge>
                {task.mode === 'workflow' ? `工作流 · ${workflow?.name ?? '已删除'}` : `对话 · ${chatAgent?.name ?? '已删除'}`}
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
              <Button variant="ghost" size="icon-sm" aria-label="删除任务" title="删除任务" onClick={() => setDeleting(true)}>
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
            <div className="mx-auto flex max-w-[780px] flex-col gap-5 px-4 py-6 md:px-6">
              {task.messages.map((m) => {
                // 进入新步骤时插一条分隔线
                let stepHeader
                const speaker = m.role === 'agent' ? `${m.agentId}:${m.step}` : ''
                const compact = !!speaker && speaker === prevSpeaker
                prevSpeaker = speaker
                if (m.role === 'agent') {
                  if (m.step >= 0 && m.step !== prevStep) stepHeader = task.steps[m.step]
                  prevStep = m.step
                }
                return (
                  <div key={m.id} className={cn('flex flex-col gap-5', compact && '-mt-3')}>
                    {stepHeader && (
                      <div className="flex items-center gap-3 text-xs text-subtle">
                        <span className="h-px flex-1 bg-line" />
                        <span>
                          步骤 {m.step + 1}/{task.steps.length} · {stepHeader.title}
                        </span>
                        <span className="h-px flex-1 bg-line" />
                      </div>
                    )}
                    {m.role === 'user' ? (
                      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md border bg-sel px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {m.text}
                      </div>
                    ) : m.role === 'system' ? (
                      <div className="flex items-center justify-center gap-1.5 text-center text-xs text-subtle">
                        <Info className="h-3.5 w-3.5 shrink-0" />
                        {m.text}
                      </div>
                    ) : (
                      <AgentMessage m={m} teamNames={teamNames} compact={compact} />
                    )}
                  </div>
                )
              })}
              {running && (
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  <Loader2 className="h-4 w-4 animate-spin text-accent" />
                  {busyAgent ? `${busyAgent.name} 正在执行` : '正在执行'}
                  {runningStep && <span className="text-subtle">· {runningStep.title}</span>}
                </div>
              )}
            </div>
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
                placeholder={running ? '执行中，完成后可以继续输入要求' : '继续输入要求，Enter 发送，Shift + Enter 换行'}
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
                          ? '会从失败的步骤重新执行'
                          : '会从没完成的步骤继续执行'
                      : `发给 ${chatAgent?.name ?? 'Agent'}`}
                </span>
                {running ? (
                  <Button size="sm" variant="secondary" className="ml-auto" onClick={stop}>
                    <Square className="h-3.5 w-3.5 fill-current" />
                    停止
                  </Button>
                ) : (
                  <Button size="icon-sm" className="ml-auto" aria-label="发送" disabled={!text.trim() || sending} onClick={send}>
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
