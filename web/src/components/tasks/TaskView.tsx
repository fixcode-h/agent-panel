import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { toast } from 'sonner'
import {
  ArrowUp,
  ChevronRight,
  FlaskConical,
  GitBranch,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  PanelRight,
  Pencil,
  RotateCw,
  Pause,
  Trash2,
  X,
  Zap,
  ListPlus,
} from 'lucide-react'
import type { Project, Task, TaskMessage } from '@shared/schema'
import { rootStepId, taskWorkflows } from '@shared/flow'
import { taskSummary } from '@shared/task'
import { api } from '@/lib/api'
import { useTaskStream } from '@/lib/task-stream'
import { useEscape } from '@/lib/useEscape'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { AgentMessage, FoldedRun } from './Messages'
import { LiveStats } from './LiveStats'
import { StepSection, SystemNote } from './StepSection'
import { TaskPanel } from './TaskPanel'
import { FileDialog, FileOpenCtx } from './FileDialog'
import { RequestCard } from './RequestCard'
import { TaskStatusIcon } from './TaskStatusIcon'
import {
  AttachMenu,
  AttachmentChips,
  MessageAttachments,
  useAttachments,
  useDropPaste,
  useFileMention,
} from './Attachments'
import { DropHint } from './TaskComposer'

/** 流程图视图用到的画布库比较大，切到流程图时才加载 */
const TaskFlow = lazy(() => import('./TaskFlow').then((m) => ({ default: m.TaskFlow })))

type Block =
  | { kind: 'msg'; m: TaskMessage }
  /** 对话里 Agent 连续的回复（一轮），完成后折叠过程 */
  | { kind: 'turn'; key: string; msgs: TaskMessage[] }
  | { kind: 'steps'; key: string; roots: string[]; byRoot: Map<string, TaskMessage[]> }

/** 把消息分段：连续的节点输出归到一段，段里再按主流程节点分开，同时执行的节点输出不会交错 */
function toBlocks(task: Task): Block[] {
  const blocks: Block[] = []
  for (const m of task.messages) {
    if (!m.step && m.role === 'agent') {
      const b = blocks.at(-1)
      if (b?.kind === 'turn') b.msgs.push(m)
      else blocks.push({ kind: 'turn', key: m.id, msgs: [m] })
      continue
    }
    if (!m.step || m.role === 'user') {
      blocks.push({ kind: 'msg', m })
      continue
    }
    let b = blocks.at(-1)
    if (b?.kind !== 'steps') {
      b = { kind: 'steps', key: m.id, roots: [], byRoot: new Map() }
      blocks.push(b)
    }
    const root = rootStepId(m.step)
    if (!b.byRoot.has(root)) (b.roots.push(root), b.byRoot.set(root, []))
    b.byRoot.get(root)!.push(m)
  }
  // 正在执行但还没有输出的节点也显示出来
  if (task.status === 'running') {
    const running = task.steps.filter((s) => !s.parentId && s.status === 'running')
    let b = blocks.at(-1)
    if (running.length && b?.kind !== 'steps') {
      b = { kind: 'steps', key: 'live', roots: [], byRoot: new Map() }
      blocks.push(b)
    }
    if (b?.kind === 'steps')
      for (const s of running) if (!b.byRoot.has(s.id)) (b.roots.push(s.id), b.byRoot.set(s.id, []))
  }
  return blocks
}

/** 一个任务的对话页：上方是执行输出，下方继续输入要求，右侧是进度、上下文和更改 */
/** project 为空时是 Chat 模式的聊天，不属于任何项目 */
export function TaskView({ taskId, project }: { taskId: string; project?: Project }) {
  const { agents, workflows, upsertTask, removeTask } = useData()
  const { go } = useNav()
  const [task, setTask] = useState<Task | null>(null)
  const [text, setText] = useState('')
  const followTa = useRef<HTMLTextAreaElement>(null)
  // 和新建任务的输入框一样：可以附文件、粘贴截图、拖进来、输入 @ 引用项目文件
  const files = useAttachments()
  const drop = useDropPaste(files.add)
  const mention = useFileMention(project?.id, text, setText, followTa)
  const [sending, setSending] = useState(false)
  const [panel, setPanel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  useEscape(panel, () => setPanel(false))
  // Esc 停止正在执行的任务（先确认，免得误触）；右栏开着时 Esc 先关右栏
  const [stopAsk, setStopAsk] = useState(false)
  // Agent 输出里点了文件路径：在弹窗里看文件内容
  const [fileTarget, setFileTarget] = useState<{ path: string; line?: number } | null>(null)
  const openFile = useCallback((path: string, line?: number) => setFileTarget({ path, line }), [])
  useEscape(task?.status === 'running' && !panel && !stopAsk, () => setStopAsk(true))
  const [view, setView] = useState<'chat' | 'flow'>('chat')
  // 右栏「任务进度」里点了哪一步：切到流程视图并选中它，和点流程图的节点一样
  const [focus, setFocus] = useState<{ id: string; at: number }>()
  const scroller = useRef<HTMLDivElement>(null)
  // 对话区左右的空白宽度：内容区宽度固定居中，窗口宽时两边留白
  const mainRef = useRef<HTMLElement>(null)
  const [gutter, setGutter] = useState(0)
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const measure = () => {
      const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-w')) || 1000
      setGutter(Math.max(0, (el.clientWidth - cw) / 2))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // 任务加载出来之前页面上还没有 main
    // 任务从无到有时开始量尺寸
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [!task])
  const stick = useRef(true)

  const apply = (next: Task) => {
    setTask(next)
    // 全局列表只放摘要，侧栏不用跟着每段输出重新渲染消息
    upsertTask(taskSummary(next))
  }

  useEffect(() => {
    api
      .task(taskId)
      .then(apply)
      .catch((e) => toast.error((e as Error).message))
    // 换任务时取一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const running = task?.status === 'running'
  useTaskStream(taskId, running, apply)

  // 停留在底部时自动跟随新输出
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current && view === 'chat') el.scrollTop = el.scrollHeight
  }, [task, view])

  // 任务创建时存下的工作流；现在的版本改过时，可以选择按新的继续
  const workflow = task ? taskWorkflows(task, workflows).workflow : undefined
  const latestWf = workflows.find((w) => w.id === task?.workflowId)
  const wfChanged = !!task?.workflows.length && !!latestWf && latestWf.updatedAt !== workflow?.updatedAt
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])

  if (!task)
    return (
      <main className="flex flex-1 items-center justify-center text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </main>
    )

  // 执行中也能发：默认排队，这一轮完成后自动处理；interrupt 先停下当前这一轮再发
  const send = async (interrupt = false) => {
    if (!text.trim() || sending || files.uploading) return
    setSending(true)
    stick.current = true
    try {
      apply(await api.sendMessage(task.id, text, files.attachments, running && interrupt))
      setText('')
      files.clear()
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
  const resume = async (latest = false) => {
    setResuming(true)
    stick.current = true
    try {
      apply(await api.resumeTask(task.id, latest))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setResuming(false)
    }
  }
  const rename = async () => {
    const title = renaming?.trim()
    setRenaming(null)
    if (!title || title === task.title) return
    try {
      apply(await api.renameTask(task.id, title))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async () => {
    try {
      await api.deleteTask(task.id)
      removeTask(task.id)
      toast.success(t('已删除任务'))
      go(project ? { page: 'projects', id: project.id } : { page: 'chat' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const tops = task.steps.filter((s) => !s.parentId)
  const runningSteps = task.steps.filter((s) => s.status === 'running')
  const chatAgent = agents.find((a) => a.id === task.agentId)
  const mainAgent = agents.find((a) => a.id === workflow?.mainAgentId)
  const blocks = toBlocks(task)
  const isFlow = task.mode === 'workflow' && view === 'flow'
  // 点了任务进度里的某一步：切到流程图并定位到那一步
  const openStep =
    task.mode === 'workflow'
      ? (id: string) => {
          setView('flow')
          setFocus({ id, at: Date.now() })
          setPanel(false)
        }
      : undefined
  // 对话两边空白够宽时，任务进度放在左边空白处，固定在那里不跟着内容滚动；右栏里就不再重复显示
  const progressCard =
    task.mode === 'workflow' && tops.length > 0 && gutter >= 200 ? (
      <div className="absolute top-4 left-4 z-10" style={{ width: Math.min(272, gutter - 24) }}>
        <TaskPanel task={task} project={project} workflow={workflow} only="progress" onStep={openStep} />
      </div>
    ) : null
  const canResume = (task.status === 'failed' || task.status === 'stopped') && !text.trim()

  return (
    <FileOpenCtx.Provider value={openFile}>
      <div className="relative flex min-h-[70vh] min-w-0 flex-1 md:h-full md:min-h-0">
        <main ref={mainRef} className="flex min-w-0 flex-1 flex-col md:h-full">
          <header
            className={cn(
              'flex h-14 shrink-0 items-center gap-2 border-b px-3 transition-colors md:px-5',
              scrolled ? 'border-line' : 'border-transparent',
            )}
          >
            <nav aria-label={t('位置')} className="flex min-w-0 flex-1 items-center gap-1 text-[13.5px]">
              <button
                onClick={() => go(project ? { page: 'projects', id: project.id } : { page: 'chat' })}
                className="hidden max-w-[30%] shrink-0 cursor-pointer truncate rounded-md px-1.5 py-1 text-muted hover:bg-sel hover:text-fg sm:block"
              >
                {project?.name ?? t('聊天')}
              </button>
              <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-subtle sm:block" />
              <TaskStatusIcon status={task.status} className="ml-1" />
              {renaming !== null ? (
                <input
                  autoFocus
                  aria-label={t('任务标题')}
                  value={renaming}
                  maxLength={80}
                  onChange={(e) => setRenaming(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={rename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-accent bg-field px-2 font-medium outline-none"
                />
              ) : (
                <h2
                  title={t('双击重命名')}
                  onDoubleClick={() => setRenaming(task.title)}
                  className="min-w-0 truncate px-1 font-medium"
                >
                  {task.title}
                </h2>
              )}
              {task.simulated && (
                <span
                  title={t('没有真正调用 CLI，输出是示例')}
                  className="hidden shrink-0 items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[11px] text-warning md:inline-flex"
                >
                  <FlaskConical className="h-3 w-3" />
                  {t('模拟')}
                </span>
              )}
            </nav>
            {task.mode === 'workflow' && (
              <div className="flex shrink-0 rounded-lg bg-field p-0.5" role="tablist" aria-label={t('视图')}>
                {(
                  [
                    ['chat', t('对话'), MessageSquareText],
                    ['flow', t('流程图'), GitBranch],
                  ] as const
                ).map(([v, label, Icon]) => (
                  <button
                    key={v}
                    role="tab"
                    aria-label={label}
                    aria-selected={view === v}
                    onClick={() => {
                      setView(v)
                      stick.current = v === 'chat'
                      if (v === 'flow' && scroller.current) scroller.current.scrollTop = 0
                    }}
                    className={cn(
                      'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium',
                      view === v ? 'bg-card text-fg shadow-card' : 'text-muted hover:text-fg',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5', v === 'flow' && 'rotate-90')} />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="xl:hidden"
              aria-label={t('显示任务面板')}
              title={t('任务进度、上下文和更改')}
              onClick={() => setPanel(true)}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('更多操作')}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => setRenaming(task.title)}>
                  <Pencil className="h-4 w-4" />
                  {t('重命名')}
                </MenuItem>
                {wfChanged && (task.status === 'failed' || task.status === 'stopped') && (
                  <MenuItem onSelect={() => resume(true)}>
                    <RotateCw className="h-4 w-4" />
                    {t('按最新的工作流继续')}
                  </MenuItem>
                )}
                <MenuItem danger onSelect={() => setDeleting(true)}>
                  <Trash2 className="h-4 w-4" />
                  {t('删除任务')}
                </MenuItem>
              </MenuContent>
            </Menu>
          </header>

          <div className="relative flex min-h-0 flex-1 flex-col">
            {!isFlow && progressCard}
            <div
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                setScrolled(el.scrollTop > 4)
              }}
              // 流程图视图自己管滚动：上面的流程图固定，只有下面的节点输出滚动
              className={isFlow ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'flex-1 overflow-y-auto'}
            >
              {isFlow ? (
                <Suspense fallback={null}>
                  <TaskFlow
                    task={task}
                    focus={focus}
                    gutter={progressCard}
                    onOpenChat={() => {
                      stick.current = true
                      setView('chat')
                    }}
                  />
                </Suspense>
              ) : (
                <div className="mx-auto flex max-w-(--content-w) flex-col gap-7 px-4 pt-4 pb-8 md:px-6">
                  {blocks.map((b, bi) =>
                    b.kind === 'turn' ? (
                      <div key={b.key} className="flex flex-col gap-4">
                        <FoldedRun msgs={b.msgs} teamNames={teamNames} live={running && bi === blocks.length - 1} />
                      </div>
                    ) : b.kind === 'steps' ? (
                      <div key={b.key} className="flex flex-col gap-7">
                        {b.roots.map((r) => (
                          <StepSection key={r} task={task} rootId={r} msgs={b.byRoot.get(r)!} teamNames={teamNames} />
                        ))}
                      </div>
                    ) : b.m.role === 'user' ? (
                      <div key={b.m.id} className="ml-auto flex max-w-[85%] flex-col items-end gap-2">
                        {!!b.m.attachments?.length && <MessageAttachments items={b.m.attachments} />}
                        <div className="rounded-2xl bg-sel px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {b.m.text}
                        </div>
                      </div>
                    ) : b.m.role === 'system' ? (
                      <SystemNote
                        key={b.m.id}
                        text={b.m.text}
                        error={b.m.error}
                        className="justify-center text-center"
                      />
                    ) : (
                      <AgentMessage key={b.m.id} m={b.m} teamNames={teamNames} />
                    ),
                  )}
                  {running && task.mode === 'chat' && (
                    <div className="flex items-center gap-2 text-[13px] text-muted">
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
                      {t('{name} 正在回复', { name: chatAgent?.name ?? 'Agent' })}
                      <LiveStats task={task} agentIds={[task.agentId]} />
                    </div>
                  )}
                  {running && task.mode === 'workflow' && runningSteps.length === 0 && (
                    <div className="flex items-center gap-2 text-[13px] text-muted">
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
                      {t('{name} 正在处理', { name: mainAgent?.name ?? t('主 Agent') })}
                      <LiveStats task={task} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="px-3 pt-1 pb-3 md:px-6 md:pb-5">
            <RequestCard task={task} onAnswered={apply} />
            <WorktreeBar task={task} onChange={apply} />
            <QueuedList task={task} onChange={apply} />
            <div
              {...drop.container}
              className={cn(
                'relative mx-auto max-w-(--content-w) rounded-[20px] border border-line-strong bg-card shadow-card transition-shadow focus-within:shadow-pop',
                drop.over && 'border-accent ring-2 ring-accent/25',
              )}
            >
              {mention.menu}
              {drop.over && <DropHint />}
              <AttachmentChips items={files.items} onRemove={files.remove} />
              <label htmlFor="follow-up" className="sr-only">
                {t('继续输入要求')}
              </label>
              <textarea
                id="follow-up"
                ref={followTa}
                rows={2}
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  mention.sync()
                }}
                onSelect={mention.sync}
                onPaste={drop.onPaste}
                onKeyDown={(e) => {
                  if (mention.onKeyDown(e)) return
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    // 执行中按 Ctrl/⌘ + Enter：打断当前这一轮，马上处理这条
                    send(e.metaKey || e.ctrlKey)
                  }
                }}
                placeholder={running ? t('执行中也可以输入，这一轮完成后接着处理') : t('继续输入要求')}
                className="block max-h-48 w-full resize-none bg-transparent px-4 pt-3.5 text-[14.5px] leading-relaxed outline-none placeholder:text-subtle focus-visible:outline-none"
              />
              <div className="flex items-center gap-1 px-2.5 pb-2.5">
                <AttachMenu onFiles={files.add} onMention={mention.start} canMention={!!project?.path} />
                <span className="min-w-0 truncate pl-1 text-xs text-subtle">
                  {running
                    ? tops.filter((s) => s.status === 'running').length > 1
                      ? t('{n} 个节点同时执行中', { n: tops.filter((s) => s.status === 'running').length })
                      : t('执行中，可以随时暂停')
                    : task.mode === 'workflow'
                      ? tops.every((s) => s.status === 'done')
                        ? t('由主 Agent {name} 处理追加要求', { name: mainAgent?.name ?? '' })
                        : task.status === 'failed'
                          ? t('会从失败的节点重新执行')
                          : t('会从没完成的节点继续执行')
                      : t('发给 {name}', { name: chatAgent?.name ?? 'Agent' })}
                </span>
                {running ? (
                  <>
                    {text.trim() ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto rounded-lg"
                          disabled={sending}
                          title={t('停下当前这一轮，马上处理这条（Ctrl/⌘ + Enter）')}
                          onClick={() => send(true)}
                        >
                          <Zap className="h-3.5 w-3.5" />
                          {t('打断并发送')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="rounded-lg"
                          disabled={sending}
                          title={t('这一轮完成后接着处理（Enter）')}
                          onClick={() => send()}
                        >
                          <ListPlus className="h-3.5 w-3.5" />
                          {t('排队')}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" className="ml-auto rounded-lg" onClick={stop}>
                        <Pause className="h-3.5 w-3.5" />
                        {t('暂停')}
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    {canResume && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="ml-auto rounded-lg"
                        disabled={resuming}
                        onClick={() => resume()}
                        title={
                          task.mode === 'workflow' && !tops.every((s) => s.status === 'done')
                            ? t('从没完成的节点继续执行')
                            : t('重新执行最后一条要求')
                        }
                      >
                        {resuming ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCw className="h-3.5 w-3.5" />
                        )}
                        {task.status === 'failed' ? t('重试') : t('继续执行')}
                      </Button>
                    )}
                    <button
                      aria-label={t('发送')}
                      title={t('发送（Enter）')}
                      disabled={!text.trim() || sending}
                      onClick={() => send()}
                      className={cn(
                        'grid h-8 w-8',
                        !canResume && 'ml-auto',
                        'shrink-0 cursor-pointer place-items-center rounded-lg bg-accent text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40',
                      )}
                    >
                      <ArrowUp className="h-4 w-4" strokeWidth={2.4} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </main>

        <aside
          aria-label={t('任务面板')}
          className={cn(
            'w-[320px] shrink-0 flex-col overflow-y-auto border-l bg-rail p-3',
            panel ? 'fixed inset-y-0 right-0 z-40 flex max-w-full shadow-pop' : 'hidden',
            'xl:static xl:z-auto xl:flex xl:h-full xl:shadow-none',
          )}
        >
          {panel && (
            <div className="mb-2 flex items-center justify-between xl:hidden">
              <span className="px-1 text-[13px] font-semibold">{t('任务面板')}</span>
              <Button
                autoFocus
                variant="ghost"
                size="icon-sm"
                aria-label={t('关闭面板')}
                onClick={() => setPanel(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          <TaskPanel
            task={task}
            project={project}
            workflow={workflow}
            onStep={openStep}
            progressClass={progressCard ? 'hidden' : undefined}
          />
        </aside>
        {panel && <div className="fixed inset-0 z-30 bg-black/40 xl:hidden" onClick={() => setPanel(false)} />}
      </div>
      <ConfirmDialog
        open={stopAsk && task.status === 'running'}
        onOpenChange={setStopAsk}
        title={t('停止这个任务？')}
        description={t('正在执行的 CLI 会被停下，之后可以点「继续执行」从中断的地方接着做。')}
        confirmText={t('停止')}
        onConfirm={async () => {
          await stop()
          setStopAsk(false)
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除任务「{title}」？', { title: task.title })}
        description={t('会删除这个任务的对话记录，不会撤销已经改动的文件。')}
        onConfirm={remove}
      />
      <FileDialog taskId={task.id} target={fileTarget} onOpenChange={(o) => !o && setFileTarget(null)} />
    </FileOpenCtx.Provider>
  )
}

/** 执行中排队的要求：这一轮完成后按顺序处理，处理前可以撤回 */
function QueuedList({ task, onChange }: { task: Task; onChange: (t: Task) => void }) {
  if (!task.queue.length) return null
  const paused = task.status !== 'running'
  return (
    <ul className="mx-auto mb-2 flex max-w-(--content-w) flex-col gap-1.5">
      {task.queue.map((q, i) => (
        <li
          key={q.id}
          className="flex items-center gap-2 rounded-xl border border-dashed border-line-strong bg-card/60 px-3 py-2 text-[13px]"
        >
          <ListPlus className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <span className="min-w-0 flex-1 truncate" title={q.text}>
            {q.text}
          </span>
          <span className="shrink-0 text-xs text-subtle">
            {paused ? t('排队中 · 任务没在执行，点「继续执行」后处理') : i === 0 ? t('下一条') : t('排队中')}
          </span>
          <button
            type="button"
            aria-label={t('撤回')}
            title={t('撤回这条要求')}
            onClick={() =>
              api
                .unqueue(task.id, q.id)
                .then(onChange)
                .catch((e) => toast.error((e as Error).message))
            }
            className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 独立分支执行的任务：停下后可以把改动合并进项目，或者整个丢弃 */
function WorktreeBar({ task, onChange }: { task: Task; onChange: (t: Task) => void }) {
  const [asking, setAsking] = useState<'merge' | 'discard' | null>(null)
  const wt = task.worktree
  if (!wt) return null
  const running = task.status === 'running'
  const target = wt.baseBranch || t('项目当前的分支')
  const finish = (merge: boolean) =>
    api
      .finishWorktree(task.id, merge)
      .then((x) => {
        onChange(x)
        setAsking(null)
        toast.success(merge ? t('已合并到「{branch}」', { branch: x.worktree?.note || target }) : t('已丢弃独立分支'))
      })
      .catch((e) => {
        setAsking(null)
        toast.error((e as Error).message)
      })
  return (
    <div className="mx-auto mb-2 flex max-w-(--content-w) flex-wrap items-center gap-2 rounded-xl border border-line bg-card/60 px-3 py-2 text-[13px]">
      <GitBranch className={cn('h-3.5 w-3.5 shrink-0', wt.state === 'active' ? 'text-accent' : 'text-subtle')} />
      <span className="min-w-0 flex-1 text-muted">
        {wt.state === 'merged'
          ? t('独立分支已合并到「{branch}」', { branch: wt.note || target })
          : wt.state === 'discarded'
            ? t('独立分支已丢弃，项目目录没有改动')
            : running
              ? t('在独立分支 {name} 上执行，不改动项目目录', { name: wt.branch })
              : t('改动在独立分支 {name} 上，还没进项目目录', { name: wt.branch })}
      </span>
      {wt.state === 'active' && !running && (
        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setAsking('discard')}>
            {t('丢弃')}
          </Button>
          <Button size="sm" onClick={() => setAsking('merge')}>
            {t('合并到「{branch}」', { branch: target })}
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={!!asking}
        onOpenChange={(o) => !o && setAsking(null)}
        title={asking === 'merge' ? t('把改动合并到「{branch}」？', { branch: target }) : t('丢弃独立分支？')}
        description={
          asking === 'merge'
            ? t('没提交的改动会先提交到任务分支，再合并进项目目录当前的分支。有冲突时不会改动项目目录。')
            : t('会删除任务分支和它的工作目录，里面的改动都会丢掉，项目目录不受影响。')
        }
        confirmText={asking === 'merge' ? t('合并') : t('丢弃')}
        onConfirm={() => finish(asking === 'merge')}
      />
    </div>
  )
}
