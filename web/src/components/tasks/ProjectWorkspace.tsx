import {
  ArrowDown,
  ArrowUp,
  Clock,
  Coins,
  DatabaseZap,
  FileInput,
  FolderGit2,
  GitBranch,
  Hourglass,
  PanelRight,
  Settings2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import { useRef, useState, type CSSProperties } from 'react'
import { toast } from '@/lib/toast'
import type { Project, Task } from '@shared/schema'
import {
  byAskedAt,
  stopReasonText,
  taskBusy,
  taskDoneDot,
  taskState,
  taskTurnUnread,
  taskWaitText,
  taskDuration,
  taskSummary,
  waitDuration,
} from '@shared/task'
import { importTaskFile } from '@/lib/task-transfer'
import { useData, useNav, useTasks } from '@/lib/data'
import { cacheRate, fmtDuration, fmtTokens, statusLabel, timeAgo } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/menu'
import { useDirInfo } from '@/components/projects/DirPicker'
import { ProjectLessonsCard } from '@/components/projects/Lessons'
import { TaskComposer } from './TaskComposer'
import { projectDefaultWorkflow } from '@shared/project-workflow'
import { TaskControlButton } from './TaskControl'
import { TaskRenameInput, useTaskRowMenu } from './TaskMenu'
import { TaskStatusIcon } from './TaskStatusIcon'
import { AnalysisMark } from './AnalysisMark'
import { cliAliveHint, cliTreeAlive } from './CliAlive'
import { isAnalysisTask } from '@/lib/analysis-report'
import { TaskView } from './TaskView'
import { ProjectFileExplorer } from '@/components/files/ProjectFileExplorer'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { IconButton } from '@/components/ui/icon-button'
import { t } from '@shared/i18n'

/** 项目首页：参考 Claude Code，上面是这个项目的任务，输入框贴在底部，和对话页的输入框在同一个位置 */
function ProjectHome({ project }: { project: Project }) {
  const { workflows, projectCategories, upsertTask } = useData()
  const { tasks, tasksLoaded } = useTasks()
  const { go, openProject } = useNav()
  const dir = useDirInfo(project.path)
  const [filesOpen, setFilesOpen] = useState(false)
  // 文件栏和任务页的右栏一样可以拖宽；上限按这一行剩下的宽度算，给主内容至少留 480
  const row = useRef<HTMLDivElement>(null)
  const filesPane = usePaneWidth('project-files', 360, 260, () => {
    const width = row.current?.clientWidth ?? window.innerWidth
    return Math.max(320, width - 480)
  })
  // 归档的任务不在这里列出（侧栏筛选「已归档」可以找到）；子对话只在父对话页里看
  // 模型设计对话属于设计模式（#/model），项目首页不列
  const all = tasks.filter((t) => t.projectId === project.id && !t.parentTaskId && !t.modelDesign)
  const archived = all.filter((t) => t.archived).length
  const list = all.filter((t) => !t.archived).sort(byAskedAt)
  // 有任务真的在跑时每秒刷新，耗时跟着走
  const now = useNow(list.some((t) => t.working))
  const groups = groupByState(list)
  const wf = projectDefaultWorkflow(project, projectCategories, workflows)
  const open = (sub?: string) => go({ page: 'projects', id: project.id, sub })
  // 导入别人导出的任务：放进这个项目，只能查看
  const file = useRef<HTMLInputElement>(null)
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      // 包里的子对话一起导入：返回父任务在前的整棵树，打开父任务就能在子对话栏看到它们
      const [tk, ...kids] = await importTaskFile(f, project.id)
      upsertTask(taskSummary(tk))
      toast.success(
        kids.length
          ? t('已导入「{title}」和 {n} 个子对话', { title: tk.title, n: kids.length })
          : t('已导入「{title}」', { title: tk.title }),
      )
      open(tk.id)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div ref={row} className="flex min-w-0 flex-1">
      <main className="panel flex min-w-0 flex-1 flex-col md:h-full">
        <div className="flex flex-1 flex-col md:min-h-0 md:overflow-y-auto">
          <header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={onImport} />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              title={t('导入别人导出的任务（对话或工作流执行），只能查看，也可以交给 AI 分析')}
              onClick={() => file.current?.click()}
            >
              <FileInput className="h-4 w-4" />
              {t('导入任务')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openProject(project.id)}>
              <Settings2 className="h-4 w-4" />
              {t('项目设置')}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={filesOpen ? t('关闭文件') : t('显示文件')}
              title={filesOpen ? t('关闭文件') : t('显示文件')}
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen((v) => !v)}
            >
              {filesOpen ? <X className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
            </Button>
          </header>
          <div className="mx-auto flex w-full max-w-(--content-w) flex-col gap-8 px-4 pt-6 pb-8 md:px-6 md:pt-12">
            <div className="flex flex-col gap-2">
              <h1 className="flex items-center gap-3 font-serif text-display leading-tight font-semibold tracking-tight">
                <FolderGit2 className="h-7 w-7 shrink-0 text-accent-text" strokeWidth={2} />
                <span className="min-w-0 truncate">{project.name}</span>
              </h1>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-subtle">
                <span className="max-w-full truncate font-mono">{project.path || t('还没有选择目录')}</span>
                {dir?.gitBranch && (
                  <span className="flex items-center gap-1">
                    <GitBranch className="h-3.5 w-3.5" />
                    <span className="font-mono">{dir.gitBranch}</span>
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <WorkflowIcon className="h-3.5 w-3.5" />
                  {wf?.name ?? t('没有默认工作流')}
                </span>
              </p>
            </div>

            {list.length === 0 && tasksLoaded ? (
              <section className="flex flex-col">
                <h2 className="mb-2 flex px-1 text-xs font-medium text-subtle">
                  <span className="flex-1">{t('任务 · {n}', { n: 0 })}</span>
                  {archived > 0 && <span className="font-normal">{t('另有 {n} 个已归档', { n: archived })}</span>}
                </h2>
                <p className="rounded-xl border border-dashed px-4 py-6 text-center text-body text-subtle">
                  {t('还没有任务。在下面描述要做的事，Agent 会按工作流完成。')}
                </p>
              </section>
            ) : (
              groups.map((g, i) => (
                <section key={g.key} className="flex flex-col">
                  <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-subtle">
                    <span className={cn('h-1.5 w-1.5 rounded-full', g.dot)} aria-hidden />
                    <span className="flex-1">
                      {g.label} · {g.items.length}
                    </span>
                    {/* 归档数只在最后一组的标题上说一次 */}
                    {i === groups.length - 1 && archived > 0 && (
                      <span className="font-normal">{t('另有 {n} 个已归档', { n: archived })}</span>
                    )}
                  </h2>
                  <ul className="flex flex-col divide-y overflow-hidden rounded-xl bg-card shadow-card">
                    {g.items.map((tk) => (
                      <ProjectTaskRow key={tk.id} task={tk} now={now} onOpen={() => open(tk.id)} />
                    ))}
                  </ul>
                </section>
              ))
            )}

            <ProjectLessonsCard project={project} />
          </div>
        </div>
        {/* 输入框贴在底部不跟着列表滚；窄屏整页滚动时用 sticky 留在底部。和输入内容相近的对话列在输入框上方 */}
        <div className="sticky bottom-0 shrink-0 bg-bg pt-2 pb-3 md:pb-5">
          {/* 左右边距和上面的列表一致，输入框和列表一样宽 */}
          <div className="mx-auto w-full max-w-(--content-w) px-4 md:px-6">
            <TaskComposer
              project={project}
              autoFocus
              onCreated={(created) => {
                upsertTask(created)
                open(created.id)
              }}
            />
          </div>
        </div>
      </main>
      {/* 文件栏：宽屏是右侧常驻的一列（宽度可拖），窄屏放不下时从右边滑出，盖住主内容而不是把它挤扁 */}
      {filesOpen && (
        <aside
          aria-label={t('文件')}
          style={{ '--panel-w': `${filesPane.width}px` } as CSSProperties}
          className={cn(
            'panel fixed inset-y-0 right-0 z-40 flex w-[min(420px,100%)] flex-col shadow-pop',
            'lg:relative lg:inset-auto lg:z-auto lg:h-full lg:w-(--panel-w) lg:shrink-0 lg:shadow-none',
          )}
        >
          <ResizeHandle pane={filesPane} label={t('拖动调整文件面板的宽度')} className="hidden lg:block" />
          {/* 面板自己的标题栏和页面标题栏同高，浮层盖住页面标题栏时也能在这里关掉 */}
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3">
            <span className="text-body font-semibold">{t('文件')}</span>
            <IconButton size="sm" icon={X} label={t('关闭文件')} onClick={() => setFilesOpen(false)} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <ProjectFileExplorer projectId={project.id} dir={project.path} />
          </div>
        </aside>
      )}
    </div>
  )
}

/** 这个任务现在要不要你处理：有确认请求、出错了、或者做完了还没看 */
function needsYou(tk: Task) {
  // 状态只从 taskState 来：等你处理、失败都要你看；还在运行的（子对话、子任务、后台命令没完）不算「做完没看」，
  // 橙点也读同一处判定（taskDoneDot），不自己比 turnDoneAt / turnSeenAt。
  // 和橙点同口径：只有完成态才归「需要你处理」，自己停下的、别的原因结束的都归 stopped，stopReason 只影响图标文字
  const s = taskState(tk)
  if (s === 'needs' || s === 'failed') return true
  return taskDoneDot(tk, taskTurnUnread(tk))
}

/**
 * 项目首页按状态分组：要你处理的放最上面，然后是正在执行的，其余按最近的要求排。
 * 组里保持原来的顺序（最近发过要求的在前），空的组不显示
 */
function groupByState(list: Task[]) {
  const all = [
    { key: 'you', label: t('需要你处理'), dot: 'bg-warning', items: [] as Task[] },
    { key: 'running', label: t('执行中'), dot: 'bg-accent', items: [] as Task[] },
    { key: 'rest', label: t('其他对话'), dot: 'bg-subtle', items: [] as Task[] },
  ]
  for (const tk of list) {
    const g = needsYou(tk) ? all[0] : taskBusy(tk) ? all[1] : all[2]
    g.items.push(tk)
  }
  return all.filter((g) => g.items.length)
}

/** 任务列表里的一行：点开任务，右键可以暂停 / 继续、重命名、归档、删除 */
function ProjectTaskRow({ task, now, onOpen }: { task: Task; now: number; onOpen: () => void }) {
  const { agents, workflows } = useData()
  const menu = useTaskRowMenu(task)
  const a = agents.find((x) => x.id === task.agentId)
  const w = workflows.find((x) => x.id === task.workflowId)
  const tops = task.steps.filter((s) => !s.parentId && s.kind !== 'main')
  const done = tops.filter((s) => s.status === 'done').length
  const state = taskState(task)
  const busy = state === 'running' || state === 'waiting'
  if (menu.renaming)
    return (
      <li className="flex items-center px-4 py-3">
        <TaskRenameInput
          task={task}
          onCommit={menu.rename}
          onCancel={() => menu.setRenaming(false)}
          className="min-w-0 flex-1 text-prose"
        />
      </li>
    )
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* 暂停 / 继续按钮不能套在整行的按钮里，放在行的右边 */}
          <li className="flex items-center transition-colors hover:bg-sel/60">
            <button
              onClick={onOpen}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-3 pl-4 pr-3 text-left"
            >
              <TaskStatusIcon
                status={task.status}
                working={busy}
                spin={busy}
                waiting={state === 'needs'}
                cliAlive={!!task.cliAlive}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  {isAnalysisTask(task, agents) && <AnalysisMark kind={task.analysis} />}
                  {/* 自己或名下子对话有活着的 CLI：标题流光 */}
                  <span
                    title={cliAliveHint(task) || undefined}
                    className={cn('truncate text-prose', cliTreeAlive(task) && 'cli-alive-title')}
                  >
                    {task.title}
                  </span>
                </span>
                <span className="truncate text-xs text-subtle">
                  {task.mode === 'workflow'
                    ? `${task.workflowName || w?.name || t('工作流已删除')}${tops.length ? t(' · {done}/{total} 个节点', { done, total: tops.length }) : ''}`
                    : t('对话 · {name}', { name: a?.name ?? t('角色已删除') })}
                </span>
                <TaskStats task={task} now={now} />
              </span>
              <span
                className={cn(
                  'hidden shrink-0 text-xs sm:block',
                  state === 'failed'
                    ? 'text-danger'
                    : state === 'needs'
                      ? 'text-warning'
                      : busy
                        ? 'text-accent-text'
                        : 'text-subtle',
                )}
              >
                {state === 'needs'
                  ? t('等你处理')
                  : state === 'waiting'
                    ? taskWaitText(task)
                    : state === 'running'
                      ? statusLabel.running
                      : task.status === 'done'
                        ? timeAgo(task.updatedAt, now)
                        : task.status === 'running' && task.cliAlive
                          ? t('等待你的下一条消息')
                          : task.status === 'running'
                            ? timeAgo(task.updatedAt, now)
                            : task.status === 'stopped'
                              ? stopReasonText(task.stopReason)
                              : statusLabel[task.status]}
              </span>
            </button>
            <TaskControlButton task={task} className="mr-4" />
          </li>
        </ContextMenuTrigger>
        <ContextMenuContent>{menu.items}</ContextMenuContent>
      </ContextMenu>
      {menu.confirm}
    </>
  )
}

/** 任务列表里的一行用量：执行时间、Token 总数、输入、输出、缓存命中 */
function TaskStats({ task, now }: { task: Task; now: number }) {
  const u = task.usage
  const ms = taskDuration(task, now)
  const total = u.inputTokens + u.outputTokens
  if (!ms && !total) return null
  const rate = cacheRate(task)
  const item = 'flex items-center gap-1 whitespace-nowrap'
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-caption text-subtle tabular-nums">
      {ms > 0 && (
        <span className={item} title={t('执行时间（不含等待继续对话的时间）')}>
          <Clock className="h-3 w-3" />
          {fmtDuration(ms)}
        </span>
      )}
      {waitDuration(task, now) >= 1000 && (
        <span className={item} title={t('其中等你确认、回答问题的时间')}>
          <Hourglass className="h-3 w-3" />
          {t('等你 {d}', { d: fmtDuration(waitDuration(task, now)) })}
        </span>
      )}
      {total > 0 && (
        <>
          <span className={item} title={t('Token 总数（输入 + 输出）')}>
            <Coins className="h-3 w-3" />
            {fmtTokens(total)}
          </span>
          <span className={item} title={t('输入 Token（含缓存命中）')}>
            <ArrowUp className="h-3 w-3" />
            {t('输入 {n}', { n: fmtTokens(u.inputTokens) })}
          </span>
          <span className={item} title={t('输出 Token')}>
            <ArrowDown className="h-3 w-3" />
            {t('输出 {n}', { n: fmtTokens(u.outputTokens) })}
          </span>
          <span
            className={item}
            title={t('缓存命中 {hit} / 输入 {input}', {
              hit: fmtTokens(u.cacheReadTokens ?? 0),
              input: fmtTokens(u.inputTokens),
            })}
          >
            <DatabaseZap className="h-3 w-3" />
            {t('缓存命中 {n}', { n: fmtTokens(u.cacheReadTokens ?? 0) })}
            <span className={cn(rate >= 0.5 ? 'text-success' : '')}>
              {t('（{n}%）', { n: (rate * 100).toFixed(0) })}
            </span>
          </span>
        </>
      )}
    </span>
  )
}

/** 点进一个项目后的工作区：项目首页（新建任务 + 任务列表）或任务对话 */
export function ProjectWorkspace({ project, sub }: { project: Project; sub?: string }) {
  if (sub) return <TaskView key={sub} taskId={sub} project={project} />
  return <ProjectHome project={project} />
}
