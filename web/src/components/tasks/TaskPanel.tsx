import { useState } from 'react'
import {
  ChevronDown,
  Circle,
  CircleCheck,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquare,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import type { Project, Task, Workflow } from '@shared/schema'
import { useData } from '@/lib/data'
import { contextUsage, fmtTokens } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { useDirInfo } from '@/components/projects/DirPicker'

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="rounded-xl border bg-card">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3.5 py-2.5 text-left text-[13px] font-semibold"
      >
        {title}
        <ChevronDown className={cn('h-3.5 w-3.5 text-subtle transition-transform', !open && '-rotate-90')} />
        <span className="ml-auto text-xs font-normal text-subtle">{extra}</span>
      </button>
      {open && <div className="px-3.5 pb-3.5">{children}</div>}
    </section>
  )
}

/** 任务页右栏：任务进度、上下文、更改、环境，参考 Claude Code 的会话侧栏 */
export function TaskPanel({ task, project, workflow }: { task: Task; project: Project; workflow?: Workflow }) {
  const { agents } = useData()
  const dir = useDirInfo(project.path)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const done = task.steps.filter((s) => s.status === 'done').length
  const ctx = contextUsage(task, workflow, agents)
  const pct = (n: number) => (n / ctx.window) * 100
  const add = task.changes.reduce((n, c) => n + c.add, 0)
  const del = task.changes.reduce((n, c) => n + c.del, 0)
  const chatAgent = byId.get(task.agentId)

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="任务进度"
        extra={task.mode === 'workflow' && task.steps.length ? `${done}/${task.steps.length}` : undefined}
      >
        {task.mode === 'workflow' ? (
          <ol className="flex flex-col">
            {task.steps.map((s, i) => {
              const a = byId.get(s.agentId)
              return (
                <li key={i} className="relative flex gap-2.5 pb-3 last:pb-0">
                  {i < task.steps.length - 1 && <span className="absolute top-5 bottom-0 left-[7px] w-px bg-line-strong" />}
                  <span className="relative mt-0.5 bg-card">
                    {s.status === 'done' ? (
                      <CircleCheck className="h-4 w-4 text-success" />
                    ) : s.status === 'running' ? (
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    ) : (
                      <Circle className="h-4 w-4 text-subtle" />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className={cn(
                        'text-[13px]',
                        s.status === 'pending' ? 'text-muted' : 'text-fg',
                        s.status === 'running' && 'font-medium',
                      )}
                    >
                      {s.title}
                    </span>
                    {a && (
                      <span className="flex items-center gap-1.5 text-xs text-subtle">
                        <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                        {a.name}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="text-xs leading-relaxed text-subtle">直接对话没有固定步骤，每次你发消息 Agent 回答一轮。</p>
        )}
      </Section>

      {task.simulated ? (
        <Section title="上下文" extra="估算">
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="font-medium text-fg">已使用 {pct(ctx.used).toFixed(1)}%</span>
            <span className="font-mono text-subtle">
              {fmtTokens(ctx.used)} / {fmtTokens(ctx.window)}
            </span>
          </div>
          <div
            className="flex h-1.5 overflow-hidden rounded-full bg-field"
            role="img"
            aria-label={`上下文已使用 ${pct(ctx.used).toFixed(1)}%`}
          >
            {ctx.parts.map((p) => (
              <span key={p.key} style={{ width: `${pct(p.tokens)}%`, background: p.color }} />
            ))}
          </div>
          <ul className="mt-2.5 flex flex-col gap-1.5 text-xs">
            {ctx.parts.map((p) => (
              <li key={p.key} className="flex items-center gap-2 text-muted">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: p.color }} />
                <span className="flex-1">{p.label}</span>
                <span className="font-mono text-subtle">{fmtTokens(p.tokens)}</span>
                <span className="w-12 text-right font-mono">{pct(p.tokens).toFixed(1)}%</span>
              </li>
            ))}
            <li className="flex items-center gap-2 text-subtle">
              <span className="h-2 w-2 shrink-0 rounded-[2px] bg-field ring-1 ring-line-strong" />
              <span className="flex-1">剩余</span>
              <span className="font-mono">{fmtTokens(ctx.window - ctx.used)}</span>
              <span className="w-12 text-right font-mono">{pct(ctx.window - ctx.used).toFixed(1)}%</span>
            </li>
          </ul>
        </Section>
      ) : (
        <Section title="上下文" extra="CLI 报告">
          {Object.keys(task.usage.agents).length === 0 ? (
            <p className="text-xs text-subtle">CLI 开始运行后会显示上下文占用。</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {Object.entries(task.usage.agents).map(([id, u]) => {
                const a = byId.get(id)
                const p = Math.min(100, (u.context / u.window) * 100)
                return (
                  <li key={id} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      {a && <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />}
                      <span className="min-w-0 flex-1 truncate text-fg">{a?.name ?? '已删除的 Agent'}</span>
                      <span className="font-mono text-subtle">
                        {fmtTokens(u.context)} / {fmtTokens(u.window)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-field">
                      <span
                        className={cn('block h-full rounded-full', p > 80 ? 'bg-warning' : 'bg-accent')}
                        style={{ width: `${Math.max(p, 1)}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] text-subtle">
                      {u.model || '默认模型'} · 已使用 {p.toFixed(1)}%
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t pt-2.5 font-mono text-[11px] text-subtle">
            <span>累计输入 {fmtTokens(task.usage.inputTokens)}</span>
            <span>输出 {fmtTokens(task.usage.outputTokens)}</span>
            {task.usage.costUsd > 0 && <span>费用 ${task.usage.costUsd.toFixed(3)}</span>}
          </div>
        </Section>
      )}

      <Section
        title="更改"
        extra={
          task.changes.length ? (
            <span className="font-mono">
              <span className="text-success">+{add}</span> <span className="text-danger">-{del}</span>
            </span>
          ) : undefined
        }
      >
        {task.changes.length ? (
          <ul className="flex flex-col gap-1">
            {task.changes.map((c) => (
              <li key={c.path} className="flex items-center gap-2 font-mono text-xs">
                <span className="min-w-0 flex-1 truncate text-muted" title={c.path}>
                  {c.path}
                </span>
                <span className="shrink-0 text-success">+{c.add}</span>
                <span className="w-8 shrink-0 text-right text-danger">{c.del ? `-${c.del}` : ''}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-subtle">还没有改动文件。</p>
        )}
      </Section>

      <Section title="环境">
        <ul className="flex flex-col gap-2 text-xs text-muted">
          <li className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="min-w-0 truncate font-mono" title={project.path}>
              {project.path || '未选择目录'}
            </span>
          </li>
          {dir?.gitBranch && (
            <li className="flex items-center gap-2">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className="truncate font-mono">{dir.gitBranch}</span>
            </li>
          )}
          <li className="flex items-center gap-2">
            {task.mode === 'workflow' ? (
              <>
                <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="truncate">工作流：{workflow?.name ?? '已删除的工作流'}</span>
              </>
            ) : (
              <>
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="truncate">
                  对话：{chatAgent?.name ?? '已删除的 Agent'}
                  {chatAgent?.model && <span className="font-mono text-subtle"> · {chatAgent.model}</span>}
                </span>
              </>
            )}
          </li>
        </ul>
      </Section>
    </div>
  )
}
