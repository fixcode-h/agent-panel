import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowUp,
  Check,
  ChevronDown,
  FolderGit2,
  GitBranch,
  MessageSquare,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { DEFAULT_AGENT_ID, type Project, type Task, type TaskMode } from '@shared/schema'
import { DEFAULT_WORKFLOW_ID } from '@shared/builtin/default'
import { entryFlow, topoOrder } from '@shared/flow'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { isReady, workflowChecks } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { defaultCli, defaultSettings } from '@shared/settings'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { useDirInfo } from '@/components/projects/DirPicker'
import { ChatModelPicker, useChatRun, type ChatRun } from './ChatModelPicker'
import {
  AttachMenu,
  AttachmentChips,
  DropHint,
  insertRefs,
  removeRef,
  useAttachments,
  useDropPaste,
  useFileMention,
} from '@/components/chat/Attachments'
import { useSlashMenu } from '@/components/chat/SlashMenu'
import { useDraft } from '@/components/chat/ChatComposer'
import { AskToggle, useNewAskUser } from '@/components/chat/AskToggle'
import { t } from '@shared/i18n'

export const chip =
  'inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] text-muted transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel'

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
  const { workflows, agents, clis, projects, projectCategories, tasks, loading, settings } = useData()
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
  // 对话直接选 CLI 和模型（用默认 Agent 执行）；空值表示默认，实际的值由 useChatRun 算出
  const [chat, setChat] = useState<ChatRun>({ cli: '', model: '', effort: '' })
  const chatRun = useChatRun(chat).run
  // 没发出去的内容按模式各自记住：切到别的模式再回来还在
  const draftKey = standalone ? 'new:chat' : fixed ? `new:project:${fixed.id}` : 'new:agent'
  const [prompt, setPrompt] = useDraft(draftKey)
  const [busy, setBusy] = useState(false)
  const [isolate, setIsolate] = useState(false)
  const [askUser, setAskUser] = useNewAskUser()
  const ta = useRef<HTMLTextAreaElement>(null)
  const files = useAttachments(draftKey, {
    insert: (refs) => insertRefs(ta, prompt, setPrompt, refs),
    remove: (ref) => setPrompt(removeRef(prompt, ref)),
  })
  const drop = useDropPaste(files.add)
  const mention = useFileMention(project?.id, prompt, setPrompt, ta)
  // 「/」菜单：对话按选的 CLI 列；工作流的节点都用默认 CLI，按它列，发出去时展开成普通的要求
  const isChat = standalone || mode === 'chat'
  const slash = useSlashMenu({
    cli: isChat ? chatRun.cli : defaultCli(settings ?? defaultSettings()),
    projectId: project?.id,
    scope: 'new',
    text: prompt,
    setText: setPrompt,
    ta,
  })

  // 独立分支要靠 git worktree，只有 git 仓库能用
  const dir = useDirInfo(project?.path ?? '')
  const canIsolate = !!project && !!dir?.gitBranch
  const busyProject = !!project && tasks.some((x) => x.projectId === project.id && x.status === 'running')

  // 项目没指定工作流时用自带的「默认」工作流：什么都能交给它，做完推荐下一步用哪个工作流
  const workflow = workflows.find((w) => w.id === (workflowId || defaultWf || DEFAULT_WORKFLOW_ID))
  // 默认按工作流执行；项目没有默认工作流时也停在工作流，让用户选一个
  const effMode: TaskMode = standalone ? 'chat' : mode || 'workflow'
  const nodes = workflow ? topoOrder(entryFlow(workflow)).length : 0
  const notReady = effMode === 'workflow' && workflow && !isReady(workflowChecks(workflow, agents, clis, workflows))
  const canStart =
    (standalone || !!project) &&
    !!prompt.trim() &&
    (effMode === 'workflow' ? !!workflow : !!chatRun.cli) &&
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
          agentId: effMode === 'chat' ? DEFAULT_AGENT_ID : '',
          cli: effMode === 'chat' ? chatRun.cli : '',
          model: effMode === 'chat' ? chatRun.model : '',
          effort: effMode === 'chat' ? chatRun.effort : '',
          params: {},
          prompt,
          attachments: files.attachments,
          isolate: canIsolate && isolate,
          askUser,
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
          'relative rounded-[20px] border border-line-strong bg-card shadow-card transition-[border-color,box-shadow] focus-within:shadow-pop dark:focus-within:border-focus dark:focus-within:ring-[3px] dark:focus-within:ring-focus-soft',
          drop.over && 'border-accent ring-2 ring-accent/25',
        )}
      >
        {mention.menu}
        {slash.menu}
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
            slash.sync()
          }}
          onSelect={() => {
            mention.sync()
            slash.sync()
          }}
          onPaste={drop.onPaste}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e) || mention.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              start()
            }
          }}
          placeholder={
            effMode === 'workflow' ? t('描述要做的事，Agent 会按工作流分工完成') : t('想问什么，或者让它做什么')
          }
          className="block max-h-80 min-h-[84px] w-full resize-none bg-transparent px-4 pt-4 text-[0.9375rem] leading-relaxed outline-none placeholder:text-subtle focus-visible:outline-none"
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
            <AttachMenu
              onFiles={files.add}
              onMention={mention.start}
              canMention={!!project?.path}
              onSession={files.addReady}
            />
            <AskToggle value={askUser} onChange={setAskUser} className="h-8 w-8 rounded-lg" />
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
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] transition-colors',
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
                          title={isReady(workflowChecks(w, agents, clis, workflows)) ? t('就绪') : t('未就绪')}
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
              <ChatModelPicker value={chat} onChange={setChat} />
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
      {/* 在哪里执行（项目、独立分支）放在输入框外面左下角，和「怎么执行」分开 */}
      {!loading && ((!fixed && !standalone) || canIsolate) && (
        <div className="-mt-2 flex flex-wrap items-center gap-1 px-1">
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
                        <span className="truncate font-mono text-[0.6875rem] text-subtle">
                          {p.path || t('未选择目录')}
                        </span>
                      </span>
                      {p.id === project?.id && <Check className="h-4 w-4 text-accent" />}
                    </PopoverClose>
                  ))}
                  {projects.length === 0 && (
                    <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有项目，先在「项目」里添加一个本机目录')}</p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {canIsolate && (
            <button
              role="switch"
              aria-checked={isolate}
              onClick={() => setIsolate((v) => !v)}
              title={t('在独立的 git 分支和目录里执行，不改动项目目录；完成后再决定合并还是丢弃')}
              className={cn(chip, isolate && 'bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent')}
            >
              <GitBranch className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('独立分支')}</span>
            </button>
          )}
        </div>
      )}
      {busyProject && canIsolate && !isolate && (
        <p className="px-1 text-xs text-subtle">
          {t('这个项目有任务正在执行。两个任务同时改一个目录容易互相覆盖，可以打开「独立分支」分开执行。')}
        </p>
      )}
      {notReady && (
        <p className="px-1 text-xs text-warning">
          {t('工作流还没就绪，执行可能会失败。可以先到工作流页面看看未通过的检查。')}
        </p>
      )}
    </div>
  )
}
