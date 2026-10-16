import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUp, Check, ChevronDown, FolderGit2, MessageSquare, Workflow as WorkflowIcon } from 'lucide-react'
import type { Project, Task, TaskMode } from '@shared/schema'
import { entryFlow, topoOrder } from '@shared/flow'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import { isReady, workflowChecks } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentPicker } from '@/components/agents/AgentPicker'

export const chip =
  'inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel'

const EXAMPLES = {
  workflow: [
    '商品详情页增加「到货提醒」，缺货时显示按钮，到货后短信通知',
    '给订单列表加上按状态筛选和分页',
    '把登录页改成支持手机号验证码登录',
  ],
  chat: ['购物车角标偶尔不刷新，帮我找找原因', '解释一下这个项目的目录结构', '帮我给 utils 里的函数补上单元测试'],
}

export function projectWorkflowId(p: Project | undefined, cats: { id: string; workflowId: string }[]) {
  return p ? p.workflowId || cats.find((c) => c.id === p.categoryId)?.workflowId || '' : ''
}

/**
 * 新建任务的输入框，参考 Claude Code：上面写要做的事，下面一排选项选项目、执行方式、工作流或 Agent。
 * 传了 project 时项目固定。
 */
export function TaskComposer({
  project: fixed,
  onCreated,
  autoFocus,
}: {
  project?: Project
  onCreated: (t: Task) => void
  autoFocus?: boolean
}) {
  const { workflows, agents, clis, projects, projectCategories } = useData()
  const { modelOf } = useAgentView()
  const [projectId, setProjectId] = useState(() => {
    try {
      return fixed?.id ?? localStorage.getItem('last-project') ?? ''
    } catch {
      return fixed?.id ?? ''
    }
  })
  const project = fixed ?? projects.find((p) => p.id === projectId) ?? projects[0]
  const defaultWf = projectWorkflowId(project, projectCategories)
  const [mode, setMode] = useState<TaskMode | ''>('')
  const [workflowId, setWorkflowId] = useState('')
  const [agentId, setAgentId] = useState(() => agents.find((a) => a.enabled)?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  const workflow = workflows.find((w) => w.id === (workflowId || defaultWf))
  const effMode: TaskMode = mode || (workflow ? 'workflow' : 'chat')
  const agent = agents.find((a) => a.id === agentId) ?? agents.find((a) => a.enabled)
  const nodes = workflow ? topoOrder(entryFlow(workflow)).length : 0
  const notReady = effMode === 'workflow' && workflow && !isReady(workflowChecks(workflow, agents, clis, workflows))
  const canStart = !!project && !!prompt.trim() && (effMode === 'workflow' ? !!workflow : !!agent) && !busy

  const start = async () => {
    if (!canStart) return
    setBusy(true)
    try {
      try {
        localStorage.setItem('last-project', project!.id)
      } catch {}
      onCreated(
        await api.createTask({
          projectId: project!.id,
          mode: effMode,
          workflowId: effMode === 'workflow' ? workflow!.id : '',
          agentId: effMode === 'chat' ? agent!.id : '',
          prompt,
        }),
      )
      setPrompt('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[20px] border border-line-strong bg-card shadow-card transition-shadow focus-within:shadow-pop">
        <label htmlFor="task-prompt" className="sr-only">
          任务描述
        </label>
        <textarea
          ref={ta}
          id="task-prompt"
          autoFocus={autoFocus}
          rows={3}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              start()
            }
          }}
          placeholder={effMode === 'workflow' ? '描述要做的事，Agent 会按工作流分工完成' : '想问什么，或者让它做什么'}
          className="block max-h-80 min-h-[84px] w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-subtle focus-visible:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1 pb-2.5">
          {!fixed && (
            <Popover>
              <PopoverTrigger className={chip} title="在哪个项目里执行">
                <FolderGit2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{project?.name ?? '选择项目'}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </PopoverTrigger>
              <PopoverContent className="w-[280px]">
                <div className="max-h-72 overflow-y-auto">
                  {projects.map((p) => (
                    <PopoverClose key={p.id} className={menuItem} onClick={() => setProjectId(p.id)}>
                      <FolderGit2 className="h-4 w-4 shrink-0 text-subtle" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{p.name}</span>
                        <span className="truncate font-mono text-[11px] text-subtle">{p.path || '未选择目录'}</span>
                      </span>
                      {p.id === project?.id && <Check className="h-4 w-4 text-accent" />}
                    </PopoverClose>
                  ))}
                  {projects.length === 0 && (
                    <p className="px-2.5 py-2 text-xs text-subtle">还没有项目，先在「项目」里添加一个本机目录</p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}

          <div role="radiogroup" aria-label="执行方式" className="flex items-center rounded-lg bg-field/60 p-0.5">
            {(
              [
                { id: 'workflow', label: '工作流', icon: WorkflowIcon },
                { id: 'chat', label: '对话', icon: MessageSquare },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={effMode === m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors',
                  effMode === m.id ? 'bg-card text-fg shadow-card' : 'text-subtle hover:text-fg',
                )}
              >
                <m.icon className="h-3.5 w-3.5" />
                {m.label}
              </button>
            ))}
          </div>

          {effMode === 'workflow' ? (
            <Popover>
              <PopoverTrigger className={chip} title="执行的工作流">
                <span className="truncate">{workflow?.name ?? '选择工作流'}</span>
                {workflow && <span className="shrink-0 text-xs text-subtle">{nodes} 个节点</span>}
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </PopoverTrigger>
              <PopoverContent className="w-[280px]">
                <div className="max-h-72 overflow-y-auto">
                  {workflows.map((w) => (
                    <PopoverClose key={w.id} className={menuItem} onClick={() => setWorkflowId(w.id)}>
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          isReady(workflowChecks(w, agents, clis, workflows)) ? 'bg-success' : 'bg-warning',
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{w.name}</span>
                        <span className="truncate text-xs text-subtle">
                          {w.id === defaultWf ? '项目默认 · ' : ''}
                          {topoOrder(entryFlow(w)).length} 个节点
                        </span>
                      </span>
                      {w.id === workflow?.id && <Check className="h-4 w-4 text-accent" />}
                    </PopoverClose>
                  ))}
                  {workflows.length === 0 && <p className="px-2.5 py-2 text-xs text-subtle">还没有工作流</p>}
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <AgentPicker onPick={(a) => setAgentId(a.id)} align="start">
              <button className={chip} title="对话的 Agent">
                {agent ? (
                  <>
                    <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" dim={!agent.enabled} />
                    <span className="truncate">{agent.name}</span>
                    <span className="hidden truncate font-mono text-[11px] text-subtle sm:inline">
                      {modelOf(agent)}
                    </span>
                  </>
                ) : (
                  <span>选择 Agent</span>
                )}
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </button>
            </AgentPicker>
          )}

          <button
            onClick={start}
            disabled={!canStart}
            aria-label="开始执行"
            title="开始执行（Enter）"
            className="ml-auto grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg bg-accent text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>
      </div>
      {notReady && (
        <p className="px-1 text-xs text-warning">
          工作流还没就绪，执行可能会失败。可以先到工作流页面看看未通过的检查。
        </p>
      )}
      {!prompt && (
        <div className="flex flex-wrap gap-2 px-0.5">
          {EXAMPLES[effMode].map((e) => (
            <button
              key={e}
              onClick={() => {
                setPrompt(e)
                ta.current?.focus()
              }}
              className="max-w-full cursor-pointer truncate rounded-lg border px-3 py-1.5 text-[12.5px] text-subtle transition-colors hover:border-line-strong hover:text-fg"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
