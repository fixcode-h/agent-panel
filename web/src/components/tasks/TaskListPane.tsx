import { useState } from 'react'
import { ChevronLeft, FolderGit2, MessageSquare, Plus, Search, Settings, Workflow as WorkflowIcon } from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { useData } from '@/lib/data'
import { timeAgo } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { TaskStatusIcon } from './TaskStatusIcon'

/** 项目内的左栏：返回项目列表、项目名和设置入口、新建任务、任务列表 */
export function TaskListPane({
  project,
  tasks,
  loading,
  selected,
  onSelect,
  onBack,
}: {
  project: Project
  tasks: Task[]
  loading: boolean
  /** 当前选中：任务 id、'new' 或 'settings' */
  selected: string
  onSelect: (sub: string) => void
  onBack: () => void
}) {
  const { agents, workflows } = useData()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = [...tasks]
    .filter((t) => !q || t.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const running = tasks.filter((t) => t.status === 'running').length

  const how = (t: Task) =>
    t.mode === 'chat'
      ? { icon: MessageSquare, text: agents.find((a) => a.id === t.agentId)?.name ?? '对话' }
      : { icon: WorkflowIcon, text: workflows.find((w) => w.id === t.workflowId)?.name ?? '工作流' }

  return (
    <section
      aria-label="任务列表"
      className="flex w-full shrink-0 flex-col border-b bg-panel md:h-full md:w-[300px] md:border-r md:border-b-0 lg:w-[320px]"
    >
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
        <button
          onClick={onBack}
          className="-ml-1 flex w-fit cursor-pointer items-center gap-0.5 rounded-md px-1 py-0.5 text-xs text-subtle hover:text-fg"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          全部项目
        </button>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[#3b6fd8] text-white">
            <FolderGit2 className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{project.name}</h1>
            <p className="truncate font-mono text-[11px] text-subtle">{project.path || '未选择目录'}</p>
          </div>
          <Button
            variant={selected === 'settings' ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label="项目设置"
            title="项目设置"
            aria-current={selected === 'settings' || undefined}
            onClick={() => onSelect('settings')}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
        <Button className="w-full" onClick={() => onSelect('new')}>
          <Plus className="h-4 w-4" />
          新建任务
        </Button>
        <label className="relative block">
          <span className="sr-only">搜索任务</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务"
            className="h-9 w-full rounded-lg border border-line-strong bg-field pr-3 pl-9 text-[13px] outline-none placeholder:text-subtle focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </label>
      </div>

      <div className="flex h-7 items-center gap-1.5 px-4 text-xs text-subtle">
        任务 · {tasks.length}
        {running > 0 && <span className="text-accent">（{running} 个执行中）</span>}
      </div>
      <div className="flex max-h-[50vh] flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3 md:max-h-none">
        {shown.map((t) => {
          const h = how(t)
          const on = t.id === selected
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              aria-current={on || undefined}
              className={cn(
                'flex w-full cursor-pointer items-start gap-2.5 rounded-[10px] border border-transparent px-2.5 py-2 text-left transition-colors',
                on ? 'border-sel-line bg-sel shadow-card' : 'hover:bg-sel/60',
              )}
            >
              <TaskStatusIcon status={t.status} className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium">{t.title}</span>
                <span className="flex items-center gap-1 text-xs text-subtle">
                  <h.icon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{h.text}</span>
                  <span className="ml-auto shrink-0">{timeAgo(t.updatedAt)}</span>
                </span>
              </span>
            </button>
          )
        })}
        {!loading && tasks.length === 0 && (
          <p className="px-3 py-6 text-center text-[13px] leading-relaxed text-subtle">
            还没有任务。点「新建任务」描述要做的事，Agent 会在这个项目的目录里执行。
          </p>
        )}
        {tasks.length > 0 && shown.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-subtle">没有匹配的任务</p>}
      </div>
    </section>
  )
}
