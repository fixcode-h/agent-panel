import {
  ArrowDown,
  ArrowUp,
  Clock,
  Coins,
  DatabaseZap,
  FolderGit2,
  GitBranch,
  Settings2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { taskDuration } from '@shared/task'
import { useData, useNav } from '@/lib/data'
import { cacheRate, fmtDuration, fmtTokens, statusLabel, timeAgo } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useDirInfo } from '@/components/projects/DirPicker'
import { TaskComposer, projectWorkflowId } from './TaskComposer'
import { TaskStatusIcon } from './TaskStatusIcon'
import { TaskView } from './TaskView'

/** 项目首页：参考 Claude Code，上面直接输入新任务，下面是这个项目的任务 */
function ProjectHome({ project }: { project: Project }) {
  const { tasks, tasksLoaded, workflows, agents, projectCategories, upsertTask } = useData()
  const { go, openProject } = useNav()
  const dir = useDirInfo(project.path)
  const list = tasks.filter((t) => t.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  // 有任务在执行时每秒刷新，耗时跟着走
  const now = useNow(list.some((t) => t.status === 'running'))
  const wf = workflows.find((w) => w.id === projectWorkflowId(project, projectCategories))
  const open = (sub?: string) => go({ page: 'projects', id: project.id, sub })

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => openProject(project.id)}>
          <Settings2 className="h-4 w-4" />
          项目设置
        </Button>
      </header>
      <div className="mx-auto flex w-full max-w-(--content-w) flex-col gap-8 px-4 pt-6 pb-16 md:px-6 md:pt-12">
        <div className="flex flex-col gap-2">
          <h1 className="flex items-center gap-3 font-serif text-[28px] leading-tight font-semibold tracking-tight">
            <FolderGit2 className="h-7 w-7 shrink-0 text-accent" strokeWidth={1.6} />
            <span className="min-w-0 truncate">{project.name}</span>
          </h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-subtle">
            <span className="max-w-full truncate font-mono">{project.path || '还没有选择目录'}</span>
            {dir?.gitBranch && (
              <span className="flex items-center gap-1">
                <GitBranch className="h-3.5 w-3.5" />
                <span className="font-mono">{dir.gitBranch}</span>
              </span>
            )}
            <span className="flex items-center gap-1">
              <WorkflowIcon className="h-3.5 w-3.5" />
              {wf?.name ?? '没有默认工作流'}
            </span>
          </p>
        </div>

        <TaskComposer
          project={project}
          autoFocus
          onCreated={(t) => {
            upsertTask(t)
            open(t.id)
          }}
        />

        <section className="flex flex-col">
          <h2 className="mb-2 px-1 text-xs font-medium text-subtle">任务 · {list.length}</h2>
          {list.length === 0 && tasksLoaded ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-subtle">
              还没有任务。在上面描述要做的事，Agent 会按工作流完成。
            </p>
          ) : (
            <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
              {list.map((t) => {
                const a = agents.find((x) => x.id === t.agentId)
                const w = workflows.find((x) => x.id === t.workflowId)
                const tops = t.steps.filter((s) => !s.parentId)
                const done = tops.filter((s) => s.status === 'done').length
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => open(t.id)}
                      className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-sel/60"
                    >
                      <TaskStatusIcon status={t.status} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[14px]">{t.title}</span>
                        <span className="truncate text-xs text-subtle">
                          {t.mode === 'workflow'
                            ? `${w?.name ?? '工作流已删除'}${tops.length ? ` · ${done}/${tops.length} 个节点` : ''}`
                            : `对话 · ${a?.name ?? 'Agent 已删除'}`}
                        </span>
                        <TaskStats task={t} now={now} />
                      </span>
                      <span
                        className={cn(
                          'hidden shrink-0 text-xs sm:block',
                          t.status === 'failed'
                            ? 'text-danger'
                            : t.status === 'running'
                              ? 'text-accent'
                              : 'text-subtle',
                        )}
                      >
                        {t.status === 'done' ? timeAgo(t.updatedAt, now) : statusLabel[t.status]}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
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
    <span className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-[11.5px] text-subtle tabular-nums">
      {ms > 0 && (
        <span className={item} title="执行时间（不含等待继续对话的时间）">
          <Clock className="h-3 w-3" />
          {fmtDuration(ms)}
        </span>
      )}
      {total > 0 && (
        <>
          <span className={item} title="Token 总数（输入 + 输出）">
            <Coins className="h-3 w-3" />
            {fmtTokens(total)}
          </span>
          <span className={item} title="输入 Token（含缓存命中）">
            <ArrowUp className="h-3 w-3" />
            输入 {fmtTokens(u.inputTokens)}
          </span>
          <span className={item} title="输出 Token">
            <ArrowDown className="h-3 w-3" />
            输出 {fmtTokens(u.outputTokens)}
          </span>
          <span
            className={item}
            title={`缓存命中 ${fmtTokens(u.cacheReadTokens ?? 0)} / 输入 ${fmtTokens(u.inputTokens)}`}
          >
            <DatabaseZap className="h-3 w-3" />
            缓存命中 {fmtTokens(u.cacheReadTokens ?? 0)}
            <span className={cn(rate >= 0.5 ? 'text-success' : '')}>（{(rate * 100).toFixed(0)}%）</span>
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
