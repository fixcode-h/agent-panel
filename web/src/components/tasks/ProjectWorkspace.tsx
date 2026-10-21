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
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Project, Task } from '@shared/schema'
import { byAskedAt, taskDuration, taskSummary, waitDuration } from '@shared/task'
import { importTaskFile } from '@/lib/task-transfer'
import { useData, useNav } from '@/lib/data'
import { cacheRate, fmtDuration, fmtTokens, statusLabel, timeAgo } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/menu'
import { useDirInfo } from '@/components/projects/DirPicker'
import { TaskComposer } from './TaskComposer'
import { projectDefaultWorkflow } from '@shared/project-workflow'
import { TaskControlButton } from './TaskControl'
import { TaskRenameInput, useTaskRowMenu } from './TaskMenu'
import { TaskStatusIcon } from './TaskStatusIcon'
import { TaskView } from './TaskView'
import { ProjectFileExplorer } from '@/components/files/ProjectFileExplorer'
import { t } from '@shared/i18n'

/** 项目首页：参考 Claude Code，上面直接输入新任务，下面是这个项目的任务 */
function ProjectHome({ project }: { project: Project }) {
  const { tasks, tasksLoaded, workflows, projectCategories, upsertTask } = useData()
  const { go, openProject } = useNav()
  const dir = useDirInfo(project.path)
  const [filesOpen, setFilesOpen] = useState(false)
  // 归档的任务不在这里列出（侧栏筛选「已归档」可以找到）；子对话只在父对话页里看
  const all = tasks.filter((t) => t.projectId === project.id && !t.parentTaskId)
  const archived = all.filter((t) => t.archived).length
  const list = all.filter((t) => !t.archived).sort(byAskedAt)
  // 有任务真的在跑时每秒刷新，耗时跟着走
  const now = useNow(list.some((t) => t.working))
  const wf = projectDefaultWorkflow(project, projectCategories, workflows)
  const open = (sub?: string) => go({ page: 'projects', id: project.id, sub })
  // 导入别人导出的任务：放进这个项目，只能查看
  const file = useRef<HTMLInputElement>(null)
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const tk = await importTaskFile(f, project.id)
      upsertTask(taskSummary(tk))
      toast.success(t('已导入「{title}」', { title: tk.title }))
      open(tk.id)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
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
      {filesOpen && (
        <div className="flex min-h-0 justify-end border-b bg-rail px-3 py-2 md:px-5">
          <div className="flex h-[min(560px,65vh)] w-[min(460px,100%)] min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-card">
            <ProjectFileExplorer projectId={project.id} dir={project.path} />
          </div>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-(--content-w) flex-col gap-8 px-4 pt-6 pb-16 md:px-6 md:pt-12">
        <div className="flex flex-col gap-2">
          <h1 className="flex items-center gap-3 font-serif text-[1.75rem] leading-tight font-semibold tracking-tight">
            <FolderGit2 className="h-7 w-7 shrink-0 text-accent" strokeWidth={1.6} />
            <span className="min-w-0 truncate">{project.name}</span>
          </h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-subtle">
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

        <TaskComposer
          project={project}
          autoFocus
          onCreated={(created) => {
            upsertTask(created)
            open(created.id)
          }}
        />

        <section className="flex flex-col">
          <h2 className="mb-2 flex px-1 text-xs font-medium text-subtle">
            <span className="flex-1">{t('任务 · {n}', { n: list.length })}</span>
            {archived > 0 && <span className="font-normal">{t('另有 {n} 个已归档', { n: archived })}</span>}
          </h2>
          {list.length === 0 && tasksLoaded ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[0.8125rem] text-subtle">
              {t('还没有任务。在上面描述要做的事，Agent 会按工作流完成。')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
              {list.map((tk) => (
                <ProjectTaskRow key={tk.id} task={tk} now={now} onOpen={() => open(tk.id)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}

/** 任务列表里的一行：点开任务，右键可以暂停 / 继续、重命名、归档、删除 */
function ProjectTaskRow({ task, now, onOpen }: { task: Task; now: number; onOpen: () => void }) {
  const { agents, workflows } = useData()
  const menu = useTaskRowMenu(task)
  const a = agents.find((x) => x.id === task.agentId)
  const w = workflows.find((x) => x.id === task.workflowId)
  const tops = task.steps.filter((s) => !s.parentId && s.kind !== 'main')
  const done = tops.filter((s) => s.status === 'done').length
  if (menu.renaming)
    return (
      <li className="flex items-center px-4 py-3">
        <TaskRenameInput
          task={task}
          onCommit={menu.rename}
          onCancel={() => menu.setRenaming(false)}
          className="min-w-0 flex-1 text-[0.875rem]"
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
              <TaskStatusIcon status={task.status} working={task.working} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[0.875rem]">{task.title}</span>
                <span className="truncate text-xs text-subtle">
                  {task.mode === 'workflow'
                    ? `${task.workflowName || w?.name || t('工作流已删除')}${tops.length ? t(' · {done}/{total} 个节点', { done, total: tops.length }) : ''}`
                    : t('对话 · {name}', { name: a?.name ?? t('Agent 已删除') })}
                </span>
                <TaskStats task={task} now={now} />
              </span>
              <span
                className={cn(
                  'hidden shrink-0 text-xs sm:block',
                  task.status === 'failed'
                    ? 'text-danger'
                    : task.working || task.childrenWorking
                      ? 'text-accent'
                      : 'text-subtle',
                )}
              >
                {task.status === 'done'
                  ? timeAgo(task.updatedAt, now)
                  : task.status === 'running' && !task.working && !task.childrenWorking
                    ? t('等待你的下一条消息')
                    : task.childrenWorking && !task.working
                      ? t('子对话执行中')
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
    <span className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-[0.71875rem] text-subtle tabular-nums">
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
