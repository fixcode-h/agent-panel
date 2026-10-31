import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { runRunning, taskGone } from '@shared/task'
import { useNav, useTasks } from '@/lib/data'
import { fmtClock, statusLabel, stepDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StepIcon } from '@/components/tasks/TaskStatusIcon'

// 工作流编辑页里「这个工作流在所选项目里跑过的执行」：底部工具条的「运行中」「重新运行」和属性栏的「运行进度」页签共用。
// 数据就是全局任务列表（摘要，有任务在跑时每 2.5 秒刷新），不另外请求

/** 这次执行用的是不是这个工作流：继续流程时可能换了工作流，以最后一次运行记录为准，旧任务没有运行记录时看任务本身 */
const usesWorkflow = (tk: Task, id: string) =>
  tk.mode === 'workflow' && (tk.runs?.at(-1)?.workflowId || tk.workflowId) === id

/**
 * 所选项目里这个工作流的执行，新的在前。只取项目里的顶层对话：
 * 「在项目里运行」只建顶层对话，子对话是父对话派出去的，重新运行它没有意义
 */
export function useFlowRuns(workflowId: string, projectId: string) {
  const { tasks } = useTasks()
  const list = projectId
    ? tasks
        .filter((tk) => tk.projectId === projectId && !tk.parentTaskId && !taskGone(tk) && usesWorkflow(tk, workflowId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : []
  const running = list.filter((tk) => runRunning(tk))
  return { last: list[0] as Task | undefined, running }
}

/** 属性栏「运行进度」页签：所选项目里最近一次执行的节点进度 */
export function RunProgress({ task, projectName }: { task?: Task; projectName: string }) {
  const { go } = useNav()
  // 执行中的节点耗时要走表；没在跑时不用定时器
  const live = !!task && runRunning(task)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  if (!task)
    return (
      <p className="p-4 text-body leading-relaxed text-subtle">
        {projectName
          ? t('这个工作流还没有在「{name}」里运行过。点底部工具条的运行按钮开始一次执行。', { name: projectName })
          : t('还没有项目。先在「项目」里添加一个本机目录，再在项目里运行这个工作流。')}
      </p>
    )
  const runId = task.runs?.at(-1)?.id
  // 只列主流程这一层的节点（子节点、主 Agent 的调度在对话页里看）；同一个对话跑过多次时只看最后一次
  const steps = task.steps.filter((s) => !s.parentId && s.kind !== 'main' && (runId === undefined || s.runId === runId))
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium" title={task.title}>
            {task.title}
          </span>
          <span className="text-caption text-subtle">
            {[statusLabel[task.status], fmtClock(task.createdAt), steps.length ? `${done}/${steps.length}` : '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => go({ page: 'projects', id: task.projectId, sub: task.id })}
          title={t('打开这次执行')}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          {t('打开')}
        </Button>
      </div>
      {steps.length ? (
        <ol aria-label={t('节点进度')} className="overflow-hidden rounded-xl border border-line">
          {steps.map((s, i) => (
            <li
              key={s.id}
              className={cn(
                'flex h-10 items-center gap-2.5 px-3 text-body',
                i > 0 && 'border-t border-line',
                (s.status === 'pending' || s.status === 'skipped') && 'text-muted',
              )}
            >
              <StepIcon status={s.status} />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="shrink-0 font-mono text-caption text-subtle">{stepDuration(s, now)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-body text-subtle">{t('这次执行还没有开始执行节点。')}</p>
      )}
    </div>
  )
}
