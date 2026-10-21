import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CornerDownRight,
  FolderGit2,
  GitBranch,
  MessageSquare,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import { DEFAULT_AGENT_ID, type Attachment, type ParamValues, type Project, type Task } from '@shared/schema'
import { dropChip, forSend } from '@shared/composer'
import { resolveParams } from '@shared/agent-role'
import { relatedTasks } from '@shared/related'
import { defaultCli, defaultSettings } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { useDirInfo } from '@/components/projects/DirPicker'
import { ChatModelPicker, useChatRun, type ChatRun } from './ChatModelPicker'
import {
  ATTACHMENT_PROMPT,
  AttachMenu,
  chipKind,
  DropHint,
  useAttachments,
  useDropPaste,
  useFileMention,
  type AttachHooks,
} from '@/components/chat/Attachments'
import { useSlashMenu } from '@/components/chat/SlashMenu'
import { RichInput, type ChipActions, type RichInputHandle } from '@/components/chat/RichInput'
import { Lightbox } from '@/components/ui/lightbox'
import { useDraft } from '@/components/chat/ChatComposer'
import { AskToggle, useNewAskUser } from '@/components/chat/AskToggle'
import { ParamsChip } from '@/components/agents/ParamFields'
import { t } from '@shared/i18n'

export const chip =
  'inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] text-muted transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel'

/**
 * 新建任务的输入框，参考 Claude Code：上面写要做的事，下面一排选项选项目、Agent，从「+」里可以改成按工作流执行。
 * 默认直接对话。传了 project 时项目固定。
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
  const { workflows, agents, projects, tasks, loading, settings } = useData()
  const [projectId, setProjectId] = useState(() => {
    try {
      return fixed?.id ?? localStorage.getItem('last-project') ?? ''
    } catch {
      return fixed?.id ?? ''
    }
  })
  const project = standalone ? undefined : (fixed ?? projects.find((p) => p.id === projectId) ?? projects[0])
  // 项目里新建的对话默认用项目设置的 Agent。勾选「用项目 Agent」时按项目设置解析：
  // 没有设置、或那个 Agent 已删除/停用时不用角色，直接跟随 CLI；不勾选时一律不用 Agent 角色
  const [useAgent, setUseAgent] = useState(true)
  // Chat 页的聊天不属于任何项目，固定用默认 Agent（和以前一样），不显示这个开关
  const wanted = standalone ? DEFAULT_AGENT_ID : useAgent ? (project?.defaultAgentId ?? '') : ''
  const agent = agents.find((a) => a.id === wanted && (a.enabled || a.id === DEFAULT_AGENT_ID))
  const agentId = wanted && wanted !== DEFAULT_AGENT_ID && !agent ? '' : wanted
  const byCli = !agentId || agentId === DEFAULT_AGENT_ID
  // Agent 的参数在新建时选好，对话开始后不能再改。换 Agent 时把上一个 Agent 的值清掉
  const [params, setParams] = useState<ParamValues>({})
  const [paramsFor, setParamsFor] = useState(agentId)
  if (paramsFor !== agentId) {
    setParamsFor(agentId)
    setParams({})
  }
  const agentParams = agent?.id === DEFAULT_AGENT_ID ? [] : (agent?.params ?? [])
  const missing = byCli || !agent ? [] : resolveParams(agentParams, params).missing
  // 开关只放图标，用来说明的话：项目没设置 Agent 时勾着也等于不用角色，要说清楚
  const agentTitle = !useAgent
    ? t('直接和 CLI 对话，不带角色的角色设定（点一下改回用项目设置的角色）')
    : agent && agent.id !== DEFAULT_AGENT_ID
      ? t('这个对话用「{name}」的角色设定和参数，开始后不能再改（点一下改成不用角色）', { name: agent.name })
      : wanted && !agent
        ? t('项目设置的角色已删除或停用，这个对话直接和 CLI 对话（点一下改成不用角色）')
        : agentId === DEFAULT_AGENT_ID
          ? t('这个对话用默认角色，CLI、模型和思考强度可以在开始前选（点一下改成不用角色）')
          : t(
              '项目设置里选了「无角色」，这个对话直接和 CLI 对话；在项目设置里选一个角色才会用角色（点一下改成不用角色）',
            )
  // 对话直接选 CLI 和模型（用默认 Agent 执行）；空值表示默认，实际的值由 useChatRun 算出
  const [chat, setChat] = useState<ChatRun>({ cli: '', model: '', effort: '' })
  const chatRun = useChatRun(chat).run
  // 没发出去的内容按模式各自记住：切到别的模式再回来还在
  const draftKey = standalone ? 'new:chat' : fixed ? `new:project:${fixed.id}` : 'new:agent'
  const [prompt, setPrompt] = useDraft(draftKey)
  // 默认对话；在「+」里选了工作流才按流程执行
  const [workflowId, setWorkflowId] = useState('')
  const workflow = workflowId ? workflows.find((w) => w.id === workflowId) : undefined
  const [busy, setBusy] = useState(false)
  const [isolate, setIsolate] = useState(false)
  const [askUser, setAskUser] = useNewAskUser()
  const editor = useRef<RichInputHandle>(null)
  const files = useAttachments(draftKey)
  const mention = useFileMention(project?.id, editor)
  /** 附件加进来时在光标处放一张卡片；上传失败就把卡片撤掉 */
  const addFiles = useCallback(
    (list: File[]) => {
      void files.add(list, {
        added: (items) =>
          items.forEach((x) => editor.current?.insertChip({ kind: chipKind(x.mime, x.name), name: x.name })),
        failed: (name) => setPrompt(dropChip(editor.current?.text() ?? '', name)),
      })
    },
    [files, editor, setPrompt],
  )
  const addReady = useCallback(
    (a: Attachment) => {
      const hooks: AttachHooks = {
        added: (items) =>
          items.forEach((x) => editor.current?.insertChip({ kind: chipKind(x.mime, x.name), name: x.name })),
      }
      files.addReady(a, hooks)
    },
    [files, editor],
  )
  /** 附件从输入框里的卡片删掉：卡片和附件一起去掉 */
  const removeFile = useCallback(
    (key: string) => {
      const item = files.items.find((x) => x.key === key)
      files.remove(key)
      if (item) setPrompt(dropChip(editor.current?.text() ?? '', item.name))
    },
    [files, editor, setPrompt],
  )
  /** 图片卡片直接显示图片本身 */
  const preview = useCallback((name: string) => files.items.find((x) => x.name === name)?.preview, [files.items])
  /** 点卡片上的图看大图、点右上角删除 */
  const lightbox = files.items.flatMap((x) => (x.preview ? [{ src: x.preview, name: x.name }] : []))
  const [openImage, setOpenImage] = useState<number>()
  const chipActions = useMemo<ChipActions>(
    () => ({
      preview: (name) => {
        const at = lightbox.findIndex((x) => x.name === name)
        if (at >= 0) setOpenImage(at)
      },
      remove: (name) => {
        const item = files.items.find((x) => x.name === name)
        if (item) removeFile(item.key)
      },
    }),
    [lightbox, files.items, removeFile],
  )
  const drop = useDropPaste(addFiles)
  // 「/」菜单：对话按选的 CLI 列；工作流的节点都用默认 CLI，按它列，发出去时展开成普通的要求
  const slash = useSlashMenu({
    cli: workflow ? defaultCli(settings ?? defaultSettings()) : chatRun.cli,
    projectId: project?.id,
    scope: 'new',
    setText: setPrompt,
    editor,
  })

  // 独立分支要靠 git worktree，只有 git 仓库能用
  const dir = useDirInfo(project?.path ?? '')
  const canIsolate = !!project && !!dir?.gitBranch
  const busyProject = !!project && tasks.some((x) => x.projectId === project.id && x.working)

  const canStart =
    (standalone || !!project) &&
    (!!prompt.trim() || files.attachments.length > 0) &&
    (workflow ? true : byCli ? !!chatRun.cli : !!agent) &&
    // 要问用户的参数没选好时不能开始：服务端也会拒绝，这里先挡住并让「参数」按钮显示警告
    (workflow || !missing.length) &&
    !busy &&
    !files.uploading

  // 项目首页：要求看起来和已有的对话是同一件事时，提示可以直接发过去接着做，不用新开一个对话从头了解
  const asked = useDeferredValue(prompt)
  const related = useMemo(
    () =>
      fixed && !workflow
        ? relatedTasks(
            asked,
            tasks.filter((x) => x.projectId === fixed.id && !x.parentTaskId && !x.archived && !x.imported),
          )
        : [],
    [asked, tasks, fixed, workflow],
  )
  const sendTo = async (id: string) => {
    if ((!prompt.trim() && !files.attachments.length) || busy || files.uploading) return
    setBusy(true)
    try {
      onCreated(
        await api.sendMessage(
          id,
          forSend(prompt, files.attachments.length ? ATTACHMENT_PROMPT : ''),
          files.attachments,
        ),
      )
      setPrompt('')
      files.clear()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    if (!canStart) return
    setBusy(true)
    try {
      try {
        if (project) localStorage.setItem('last-project', project.id)
      } catch {}
      const byWorkflow = !!workflow
      onCreated(
        await api.createTask({
          projectId: project?.id ?? '',
          mode: byWorkflow ? 'workflow' : 'chat',
          workflowId: workflow?.id ?? '',
          agentId: byWorkflow ? '' : agentId,
          cli: byWorkflow || !byCli ? '' : chatRun.cli,
          model: byWorkflow || !byCli ? '' : chatRun.model,
          effort: byWorkflow || !byCli ? '' : chatRun.effort,
          // 参数跟着 Agent 走：没有 Agent 角色（直接对话）时没有参数可选
          params: byWorkflow || byCli ? {} : params,
          prompt: forSend(prompt, files.attachments.length ? ATTACHMENT_PROMPT : ''),
          attachments: files.attachments,
          // 只有打开了「独立分支」才传；子对话一律不建独立分支
          isolate: canIsolate && isolate ? true : undefined,
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

  // 独立分支：和 Agent 开关一样只显示图标，放在输入框里。只有顶层对话能开，子对话都跟着父对话的目录
  const isolateSwitch = canIsolate && (
    <button
      type="button"
      role="switch"
      aria-checked={isolate}
      aria-label={t('独立分支')}
      onClick={() => setIsolate((v) => !v)}
      title={t(
        '独立分支：在单独的 git 分支和目录里执行，不改动项目目录，完成后再决定合并还是丢弃；它分出的子对话也在这个目录里',
      )}
      className={cn(
        chip,
        'w-8 justify-center px-0',
        isolate ? 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent' : 'text-subtle',
      )}
    >
      <GitBranch className="h-4 w-4 shrink-0" />
    </button>
  )

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
        <Lightbox images={lightbox} index={openImage} onClose={() => setOpenImage(undefined)} />
        <RichInput
          id="task-prompt"
          handle={editor}
          label={t('任务描述')}
          autoFocus={autoFocus}
          value={prompt}
          onChange={setPrompt}
          onSync={() => {
            mention.sync()
            slash.sync()
          }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e) || mention.onKeyDown(e)) return true
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              start()
              return true
            }
            return false
          }}
          onPaste={drop.onPaste}
          preview={preview}
          actions={chipActions}
          placeholder={workflow ? t('描述要做的事，Agent 会按工作流分工完成') : t('想问什么，或者让它做什么')}
          pad="px-4 pt-4"
          className="max-h-80 min-h-[84px] text-[0.9375rem] leading-relaxed"
        />
        {loading ? (
          // 数据还没到时先占位，不要闪一下「选择项目」「对话」再跳成别的
          <div className="flex items-center gap-2 px-3.5 pt-1 pb-3" aria-hidden>
            {[96, 120, 110].map((w) => (
              <span key={w} className="h-7 animate-pulse rounded-lg bg-field" style={{ width: w }} />
            ))}
            <span className="ml-auto h-8 w-8 rounded-lg bg-accent/40" />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1 px-2.5 pt-1 pb-2.5">
            <AttachMenu
              onFiles={addFiles}
              onMention={mention.start}
              canMention={!!project?.path}
              onSession={addReady}
              onWorkflow={standalone || !project ? undefined : setWorkflowId}
              workflowId={workflowId}
            />
            <AskToggle value={askUser} onChange={setAskUser} className="h-8 w-8 rounded-lg" />
            {workflow ? (
              <>
                {isolateSwitch}
                <span
                  className={cn(chip, 'cursor-default')}
                  title={t('按工作流「{name}」的流程图执行', { name: workflow.name })}
                >
                  <WorkflowIcon className="h-4 w-4 shrink-0 text-subtle" />
                  <button
                    type="button"
                    onClick={() => setWorkflowId('')}
                    aria-label={t('改回直接对话')}
                    title={t('改回直接对话')}
                    className="-mr-1 grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              </>
            ) : (
              <>
                {/* 用不用项目设置的 Agent 在新建时决定，对话开始后就不能再改 */}
                {!standalone && project && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={useAgent}
                    aria-label={t('使用项目设置的角色')}
                    title={agentTitle}
                    onClick={() => setUseAgent((v) => !v)}
                    className={cn(
                      chip,
                      'w-8 justify-center px-0',
                      useAgent ? 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent' : 'text-subtle',
                    )}
                  >
                    <Bot className="h-4 w-4 shrink-0" />
                  </button>
                )}
                {isolateSwitch}
                {byCli ? (
                  <ChatModelPicker value={chat} onChange={setChat} />
                ) : (
                  agentParams.length > 0 && <ParamsChip params={agentParams} values={params} onChange={setParams} />
                )}
              </>
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
      {!loading && !fixed && !standalone && (
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
        </div>
      )}
      {related.length > 0 && (
        <div className="-mt-1 flex flex-col gap-1 px-1" aria-label={t('可能相关的对话')}>
          <span className="text-xs text-subtle">{t('看起来和这些对话是同一件事，可以直接发过去接着做：')}</span>
          {related.map(({ task: x }) => (
            <button
              key={x.id}
              type="button"
              disabled={busy}
              onClick={() => sendTo(x.id)}
              title={t('把这条要求发到「{title}」', { title: x.title })}
              className="group flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[0.8125rem] text-muted transition-colors hover:bg-sel hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 truncate">{x.title}</span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-subtle group-hover:text-accent">
                <CornerDownRight className="h-3.5 w-3.5" />
                {t('发到这里')}
              </span>
            </button>
          ))}
        </div>
      )}
      {busyProject && canIsolate && !isolate && (
        <p className="px-1 text-xs text-subtle">
          {t('这个项目有任务正在执行。两个任务同时改一个目录容易互相覆盖，可以打开「独立分支」分开执行。')}
        </p>
      )}
    </div>
  )
}
