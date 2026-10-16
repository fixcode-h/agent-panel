import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUp, Check, ChevronDown, FolderGit2, MessageSquare, Workflow as WorkflowIcon } from 'lucide-react'
import { DEFAULT_AGENT_ID, type Project, type Task, type TaskMode } from '@shared/schema'
import { entryFlow, topoOrder } from '@shared/flow'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import { isReady, workflowChecks } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { AgentPicker } from '@/components/agents/AgentPicker'
import { ChatModelPicker } from './ChatModelPicker'
import { AttachMenu, AttachmentChips, useAttachments, useDropPaste, useFileMention } from './Attachments'
import { t } from '@shared/i18n'

export const chip =
  'inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel'

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
  standalone,
}: {
  project?: Project
  onCreated: (t: Task) => void
  autoFocus?: boolean
  /** Chat 模式的聊天：不属于任何项目，只能直接和 Agent 对话 */
  standalone?: boolean
}) {
  const { workflows, agents, clis, projects, projectCategories, loading } = useData()
  const { modelOf } = useAgentView()
  const [projectId, setProjectId] = useState(() => {
    try {
      return fixed?.id ?? localStorage.getItem('last-project') ?? ''
    } catch {
      return fixed?.id ?? ''
    }
  })
  const project = standalone ? undefined : (fixed ?? projects.find((p) => p.id === projectId) ?? projects[0])
  const defaultWf = projectWorkflowId(project, projectCategories)
  const [mode, setMode] = useState<TaskMode | ''>('')
  const [workflowId, setWorkflowId] = useState('')
  // 对话默认用自带的默认 Agent；用户主动选过别的就记住
  const [agentId, setAgentId] = useState(() => {
    try {
      return localStorage.getItem('last-chat-agent') || DEFAULT_AGENT_ID
    } catch {
      return DEFAULT_AGENT_ID
    }
  })
  const pickAgent = (id: string) => {
    setAgentId(id)
    try {
      localStorage.setItem('last-chat-agent', id)
    } catch {}
  }
  const [chatModel, setChatModel] = useState({ model: '', effort: '' })
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const files = useAttachments()
  const drop = useDropPaste(files.add)
  const mention = useFileMention(project?.id, prompt, setPrompt, ta)

  const workflow = workflows.find((w) => w.id === (workflowId || defaultWf))
  // 默认按工作流执行；项目没有默认工作流时也停在工作流，让用户选一个
  const effMode: TaskMode = standalone ? 'chat' : mode || 'workflow'
  const agent =
    agents.find((a) => a.id === agentId && a.enabled) ??
    agents.find((a) => a.id === DEFAULT_AGENT_ID) ??
    agents.find((a) => a.enabled)
  const isDefault = agent?.id === DEFAULT_AGENT_ID
  const nodes = workflow ? topoOrder(entryFlow(workflow)).length : 0
  const notReady = effMode === 'workflow' && workflow && !isReady(workflowChecks(workflow, agents, clis, workflows))
  const canStart =
    (standalone || !!project) &&
    !!prompt.trim() &&
    (effMode === 'workflow' ? !!workflow : !!agent) &&
    !busy &&
    !files.uploading

  const start = async () => {
    if (!canStart) return
    setBusy(true)
    try {
      try {
        if (project) localStorage.setItem('last-project', project.id)
      } catch {}
      onCreated(
        await api.createTask({
          projectId: project?.id ?? '',
          mode: effMode,
          workflowId: effMode === 'workflow' ? workflow!.id : '',
          agentId: effMode === 'chat' ? agent!.id : '',
          model: effMode === 'chat' && isDefault ? chatModel.model : '',
          effort: effMode === 'chat' && isDefault ? chatModel.effort : '',
          prompt,
          attachments: files.attachments,
        }),
      )
      setPrompt('')
      files.clear()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        {...drop.container}
        className={cn(
          'relative rounded-[20px] border border-line-strong bg-card shadow-card transition-shadow focus-within:shadow-pop',
          drop.over && 'border-accent ring-2 ring-accent/25',
        )}
      >
        {mention.menu}
        {drop.over && <DropHint />}
        <AttachmentChips items={files.items} onRemove={files.remove} />
        <label htmlFor="task-prompt" className="sr-only">
          {t('任务描述')}
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
            mention.sync()
          }}
          onSelect={mention.sync}
          onPaste={drop.onPaste}
          onKeyDown={(e) => {
            if (mention.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              start()
            }
          }}
          placeholder={
            effMode === 'workflow' ? t('描述要做的事，Agent 会按工作流分工完成') : t('想问什么，或者让它做什么')
          }
          className="block max-h-80 min-h-[84px] w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-subtle focus-visible:outline-none"
        />
        {loading ? (
          // 数据还没到时先占位，不要闪一下「选择项目」「对话」再跳成工作流
          <div className="flex items-center gap-2 px-3.5 pt-1 pb-3" aria-hidden>
            {[96, 120, 110].map((w) => (
              <span key={w} className="h-7 animate-pulse rounded-lg bg-field" style={{ width: w }} />
            ))}
            <span className="ml-auto h-8 w-8 rounded-lg bg-accent/40" />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1 pb-2.5">
            <AttachMenu onFiles={files.add} onMention={mention.start} canMention={!!project?.path} />
            {!fixed && !standalone && (
              <Popover>
                <PopoverTrigger className={chip} title={t('在哪个项目里执行')}>
                  <FolderGit2 className="h-4 w-4 shrink-0" />
                  <span className="truncate">{project?.name ?? t('选择项目')}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                </PopoverTrigger>
                <PopoverContent className="w-[280px]">
                  <div className="max-h-72 overflow-y-auto">
                    {projects.map((p) => (
                      <PopoverClose key={p.id} className={menuItem} onClick={() => setProjectId(p.id)}>
                        <FolderGit2 className="h-4 w-4 shrink-0 text-subtle" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{p.name}</span>
                          <span className="truncate font-mono text-[11px] text-subtle">
                            {p.path || t('未选择目录')}
                          </span>
                        </span>
                        {p.id === project?.id && <Check className="h-4 w-4 text-accent" />}
                      </PopoverClose>
                    ))}
                    {projects.length === 0 && (
                      <p className="px-2.5 py-2 text-xs text-subtle">
                        {t('还没有项目，先在「项目」里添加一个本机目录')}
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {!standalone && (
              <div
                role="radiogroup"
                aria-label={t('选择执行方式')}
                className="flex items-center rounded-lg bg-field/60 p-0.5"
              >
                {(
                  [
                    { id: 'workflow', label: t('工作流'), icon: WorkflowIcon },
                    { id: 'chat', label: t('对话'), icon: MessageSquare },
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
            )}

            {effMode === 'workflow' ? (
              <Popover>
                <PopoverTrigger className={chip} title={t('执行的工作流')}>
                  <span className="truncate">{workflow?.name ?? t('选择工作流')}</span>
                  {workflow && <span className="shrink-0 text-xs text-subtle">{t('{n} 个节点', { n: nodes })}</span>}
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
                            {w.id === defaultWf ? t('项目默认 · ') : ''}
                            {t('{n} 个节点', { n: topoOrder(entryFlow(w)).length })}
                          </span>
                        </span>
                        {w.id === workflow?.id && <Check className="h-4 w-4 text-accent" />}
                      </PopoverClose>
                    ))}
                    {workflows.length === 0 && <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有工作流')}</p>}
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <div className="flex min-w-0 items-center gap-0.5">
                <AgentPicker onPick={(a) => pickAgent(a.id)} align="start">
                  <button
                    className={chip}
                    title={agent && !isDefault ? `${agent.name} · ${modelOf(agent)}` : t('对话的 Agent')}
                  >
                    {agent ? (
                      <>
                        <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" dim={!agent.enabled} />
                        <span className="truncate">{agent.name}</span>
                      </>
                    ) : (
                      <span>{t('选择 Agent')}</span>
                    )}
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  </button>
                </AgentPicker>
                {isDefault && <ChatModelPicker {...chatModel} onChange={setChatModel} />}
              </div>
            )}

            <button
              onClick={start}
              disabled={!canStart}
              aria-label={t('开始执行')}
              title={t('开始执行（Enter）')}
              className="ml-auto grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg bg-accent text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.4} />
            </button>
          </div>
        )}
      </div>
      {notReady && (
        <p className="px-1 text-xs text-warning">
          {t('工作流还没就绪，执行可能会失败。可以先到工作流页面看看未通过的检查。')}
        </p>
      )}
    </div>
  )
}

/** 拖文件进来时盖在输入框上的提示 */
export function DropHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[20px] bg-card/90 text-[13px] text-accent">
      {t('松开鼠标，把文件附到要求里')}
    </div>
  )
}
