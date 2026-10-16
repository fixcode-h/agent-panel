import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowUp, ChevronDown, ChevronRight, MessageSquare, Workflow as WorkflowIcon } from 'lucide-react'
import type { Project, Task, TaskMode } from '@shared/schema'
import { planTask, taskStages } from '@shared/flow'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { fieldClass } from '@/components/ui/input'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentPicker } from '@/components/agents/AgentPicker'
import { WorkflowPicker } from '@/components/workflows/WorkflowPicker'
import { useAgentView } from '@/lib/agent-view'

/** 新建任务：选择按工作流执行还是直接和某个 Agent 对话，再描述要做的事 */
export function NewTask({ project, onCreated }: { project: Project; onCreated: (t: Task) => void }) {
  const { modelOf } = useAgentView()
  const { workflows, agents, clis, projectCategories } = useData()
  const projectWorkflowId =
    project.workflowId || projectCategories.find((c) => c.id === project.categoryId)?.workflowId || ''
  const projectWorkflow = workflows.find((w) => w.id === projectWorkflowId)
  const [mode, setMode] = useState<TaskMode>(projectWorkflow ? 'workflow' : 'chat')
  const [workflowId, setWorkflowId] = useState('')
  const [agentId, setAgentId] = useState(() => agents.find((a) => a.enabled)?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  const workflow = workflows.find((w) => w.id === (workflowId || projectWorkflowId))
  const plan = planTask(workflow, agents)
  const agent = agents.find((a) => a.id === agentId)
  const notReady = mode === 'workflow' && workflow && !isReady(workflowChecks(workflow, agents, clis))
  const canStart = !!prompt.trim() && (mode === 'workflow' ? !!workflow : !!agent) && !busy

  const start = async () => {
    if (!canStart) return
    setBusy(true)
    try {
      onCreated(
        await api.createTask({
          projectId: project.id,
          mode,
          workflowId,
          agentId,
          prompt,
        }),
      )
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  const modes = [
    {
      id: 'workflow' as const,
      icon: WorkflowIcon,
      title: '按工作流执行',
      desc: '主 Agent 按工作流文档逐步推进，把步骤分派给子 Agent',
    },
    {
      id: 'chat' as const,
      icon: MessageSquare,
      title: '直接对话',
      desc: '和一个 Agent 一问一答，随时可以让它动手修改',
    },
  ]

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 py-10 md:px-8 md:py-14">
        <div>
          <h2 className="text-xl font-semibold">新建任务</h2>
          <p className="mt-1 text-[13px] text-muted">
            在「{project.name}」里执行
            {project.path && <span className="font-mono text-xs text-subtle"> · {project.path}</span>}
          </p>
        </div>

        <div role="radiogroup" aria-label="执行方式" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {modes.map((m) => {
            const on = mode === m.id
            return (
              <button
                key={m.id}
                role="radio"
                aria-checked={on}
                onClick={() => setMode(m.id)}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
                  on ? 'border-accent bg-accent-soft' : 'bg-card hover:border-line-strong',
                )}
              >
                <span
                  className={cn(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                    on ? 'bg-accent text-white' : 'bg-field text-muted',
                  )}
                >
                  <m.icon className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] font-medium">{m.title}</span>
                  <span className="text-xs leading-relaxed text-subtle">{m.desc}</span>
                </span>
              </button>
            )
          })}
        </div>

        {mode === 'workflow' ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted">工作流</span>
            <WorkflowPicker
              value={workflowId}
              onChange={setWorkflowId}
              emptyLabel={projectWorkflow ? `使用项目工作流：${projectWorkflow.name}` : '项目还没有指定工作流，请选择'}
            />
            {plan.steps.length > 0 && (
              <ol className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted" aria-label="执行流程">
                {taskStages(plan).map((st, si, all) => (
                  <li key={st.index} className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'flex flex-col gap-1',
                        st.steps.length > 1 && 'rounded-xl border border-dashed border-line-strong p-1',
                      )}
                      title={st.steps.length > 1 ? `${st.title}：${st.steps.length} 个节点并行` : undefined}
                    >
                      {st.steps.map(({ step: s }) => {
                        const a = agents.find((x) => x.id === s.agentId)
                        return (
                          <span
                            key={s.id}
                            className="flex items-center gap-1.5 rounded-full border bg-card py-0.5 pr-2.5 pl-1"
                          >
                            {a ? <AgentAvatar icon={a.icon} cli={a.cli} size="xs" /> : <span className="w-1" />}
                            {s.title}
                          </span>
                        )
                      })}
                    </span>
                    {si < all.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-subtle" />}
                  </li>
                ))}
              </ol>
            )}
            {notReady && (
              <p className="text-xs text-warning">
                工作流还没就绪，执行可能会失败，可以先去工作流页面看看未通过的检查。
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted">对话的 Agent</span>
            <AgentPicker onPick={(a) => setAgentId(a.id)} align="start">
              <button className={cn(fieldClass, 'flex h-10 cursor-pointer items-center gap-2.5 text-left')}>
                {agent ? (
                  <>
                    <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" dim={!agent.enabled} />
                    <span className="flex-1 truncate">{agent.name}</span>
                    <span className="font-mono text-xs text-subtle">{modelOf(agent)}</span>
                  </>
                ) : (
                  <span className="flex-1 text-subtle">选择一个 Agent</span>
                )}
                <ChevronDown className="h-4 w-4 text-subtle" />
              </button>
            </AgentPicker>
          </div>
        )}

        <div className="rounded-2xl border border-line-strong bg-card shadow-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent-soft">
          <label htmlFor="task-prompt" className="sr-only">
            任务描述
          </label>
          <textarea
            id="task-prompt"
            autoFocus
            rows={6}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
            }}
            placeholder={
              mode === 'workflow'
                ? '描述要做的事，例如：商品详情页增加「到货提醒」，缺货时显示按钮，到货后短信通知'
                : '想问什么或让它做什么，例如：购物车角标偶尔不刷新，帮我找找原因'
            }
            className="block w-full resize-none bg-transparent px-4 pt-3.5 focus-visible:outline-none text-[14px] leading-relaxed outline-none placeholder:text-subtle"
          />
          <div className="flex items-center gap-2 px-3 pb-3">
            <span className="text-xs text-subtle">Ctrl / ⌘ + Enter 开始</span>
            <Button className="ml-auto" disabled={!canStart} onClick={start}>
              <ArrowUp className="h-4 w-4" />
              开始执行
            </Button>
          </div>
        </div>
      </div>
    </main>
  )
}
