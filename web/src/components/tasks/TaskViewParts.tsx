import { memo, useState } from 'react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import {
  ArrowRight,
  ChevronRight,
  GitBranch,
  GitMerge,
  Loader2,
  MessageSquareText,
  RotateCw,
  Trash2,
  X,
  Workflow as WorkflowIcon,
  Square,
} from 'lucide-react'
import { WaitDots } from './CliAlive'
import { type Task, type TaskMessage, type TaskStep } from '@shared/schema'
import { useChatRun, useRunAuthor, type ChatRun } from './ChatModelPicker'
import { topSteps } from '@shared/flow'
import { helperRunning, type ChildWait } from '@shared/task'
import { api } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { apiQueueWait, fmtDuration, tpsNow } from '@/lib/tasks'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { ChatReply, PendingAuthor } from './Messages'
import { useAgentView } from '@/lib/agent-view'
import { LiveStats } from './LiveStats'
import { WorktreeMark, needsMerge, useWorktreeActions, useWorktrees, worktreeKey, worktreeSummary } from './Worktrees'
import { StepIcon, TaskStatusIcon } from './TaskStatusIcon'

// TaskView 里的几个独立小部件：运行清单、流程条、独立分支条、一轮回复、等待行、运行阶段。
// 拆出来是为了让 TaskView 主文件只留布局和数据装配（文件行数上限见 scripts/file-caps.json）

/**
 * 对话里启动的一次工作流运行：按节点列成一张清单卡片。
 * 节点下有多步 / 子 Agent 时缩进一级展示，点卡片去右栏看完整输出。
 */
export function RunChecklist({ task, run, onOpen }: { task: Task; run: number; onOpen: () => void }) {
  const { agents } = useData()
  const rec = task.runs?.find((r) => r.id === run)
  const steps = task.steps.filter((s) => s.runId === run && s.kind !== 'main')
  const roots = steps.filter((s) => !s.parentId)
  const kids = (id: string) => steps.filter((s) => s.parentId === id && (s.slot === 'step' || s.slot === 'sub'))
  const working = steps.some((s) => s.status === 'running')
  const status: Task['status'] =
    rec?.status === 'running' || (!rec?.status && working) ? 'running' : (rec?.status ?? 'done')
  const who = (id: string) => agents.find((a) => a.id === id)?.name ?? ''
  const row = (s: TaskStep, child = false) => (
    <div key={s.id} className={cn('flex min-w-0 items-center gap-2 py-1.5', child ? 'pr-3 pl-10' : 'px-3')}>
      {child && <span className="h-px w-3 shrink-0 bg-line-strong" />}
      <StepIcon status={s.status} />
      <span className="min-w-0 flex-1 truncate text-body">{s.title}</span>
      <span className="shrink-0 text-caption text-subtle">{who(s.agentId)}</span>
    </div>
  )
  // 对话里 start_plan 跑的这一次还没结束：可以单独终止它，对话不停，收到结果后自己决定改动留不留
  const canStop = task.mode === 'chat' && rec?.status === 'running' && task.status === 'running'
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    setStopping(true)
    try {
      await api.stopRun(task.id)
      toast.success(t('已终止工作流，对话会决定这次的改动保留还是清理'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setStopping(false)
    }
  }
  return (
    // 和工作流运行卡片同一层浅底（组件库「计划 · 工作流」），不描边、不加阴影
    <div className="overflow-hidden rounded-xl bg-sel/45">
      <div className="flex items-center transition-colors hover:bg-sel/60">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pl-3 text-left"
        >
          <TaskStatusIcon status={status} working={working} />
          <span className="min-w-0 flex-1 truncate text-body font-semibold">
            {rec?.workflowName || task.workflowName || t('工作流')}
          </span>
          <span className="shrink-0 text-xs text-subtle">{t('第 {n} 次运行', { n: run })}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
        </button>
        <span className={cn('flex shrink-0 items-center', canStop ? 'px-2' : 'pr-3')}>
          {canStop && (
            <IconButton
              size="2xs"
              tone="danger"
              icon={stopping ? undefined : Square}
              label={t('终止工作流')}
              title={t('只终止这次工作流运行，对话不停；这次运行改的文件由对话决定保留还是清理')}
              disabled={stopping}
              onClick={stop}
            >
              {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : undefined}
            </IconButton>
          )}
        </span>
      </div>
      <div className="flex flex-col pb-1">
        {roots.map((s) => (
          <div key={s.id}>
            {row(s)}
            {kids(s.id).map((k) => row(k, true))}
          </div>
        ))}
        {!roots.length && <div className="px-3 py-2 text-xs text-subtle">{t('正在准备节点…')}</div>}
      </div>
    </div>
  )
}

/** 导入的任务在输入框的位置显示来源，只能查看；可以交给 AI 分析 */
/** 用户消息下面的小按钮（分叉、撤回） */

/** 输入框上面一行的提示条（没走完的流程）：本身有实质内容，保留虚线圆角的框 */
export const barRow =
  'flex items-center gap-2 rounded-xl border border-dashed border-line-strong bg-card/60 px-3 py-2 text-body'

/** 工作流没走完（失败、暂停、停在某个节点的结论上）：可以继续流程，或者结束它不再继续 */
export function FlowBar({
  task,
  blocked,
  resuming,
  onResume,
  onChange,
}: {
  task: Task
  blocked?: TaskStep
  resuming: boolean
  onResume: () => void
  onChange: (t: Task) => void
}) {
  const [asking, setAsking] = useState(false)
  const tops = topSteps(task)
  const failed = tops.find((s) => s.status === 'failed')
  const left = tops.filter((s) => s.status !== 'done' && s.status !== 'skipped').length
  const what = blocked
    ? t('流程停在「{title}」：结论不通过，后面的节点还没执行', { title: blocked.title })
    : failed
      ? t('流程没有完成：「{title}」执行失败', { title: failed.title })
      : left
        ? t('流程没有完成，还有 {n} 个节点没执行', { n: left })
        : t('流程没有完成，主角色还没整理结果')
  return (
    <div className="mx-auto mb-2 max-w-(--content-w)">
      <div className={barRow}>
        <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate" title={what}>
          {what}
        </span>
        <button
          type="button"
          disabled={resuming}
          onClick={onResume}
          title={
            blocked ? t('从「{title}」重新检查，接着走流程', { title: blocked.title }) : t('从没完成的节点继续执行')
          }
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-accent-text hover:bg-accent/10 disabled:opacity-50"
        >
          {resuming ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
          {t('继续流程')}
        </button>
        <IconButton icon={X} label={t('结束流程')} title={t('结束流程，不再继续')} onClick={() => setAsking(true)} />
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('结束这个流程？')}
        description={t('没完成的节点不再执行，已经做完的改动保留。之后输入的要求由主角色直接处理。')}
        confirmText={t('结束流程')}
        onConfirm={() =>
          api
            .endFlow(task.id)
            .then((x) => {
              onChange(x)
              setAsking(false)
            })
            .catch((e) => {
              setAsking(false)
              toast.error((e as Error).message)
            })
        }
      />
    </div>
  )
}

/**
 * 输入框上面的独立分支条：从哪个分支开出 → 独立分支，合没合回去（绿勾 / 感叹号），
 * 这一轮没在动手时可以直接合并或删除
 */
export function WorktreeBar({ task }: { task: Task }) {
  const wt = task.worktree
  const items = useWorktrees(task.id, worktreeKey(task), !!wt)
  const actions = useWorktreeActions(task.id)
  // 要改文件时才开：还没开时说明现在在哪个目录，免得以为已经在分支里了
  if (!wt && task.wantsWorktree)
    return (
      <div className="mx-auto mb-2 flex max-w-(--content-w) items-center gap-2 rounded-xl border border-line bg-card/60 px-3 py-2 text-body">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 text-muted">{t('还在项目目录里查看，要改文件时才开独立分支')}</span>
      </div>
    )
  if (!wt) return null
  const item = items?.find((x) => x.taskId === task.id)
  const active = wt.state === 'active'
  const busy = actions.busy === task.id
  return (
    <div className="mx-auto mb-2 flex max-w-(--content-w) flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-line bg-card/60 px-3 py-1.5 text-body">
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
      ) : item ? (
        <WorktreeMark item={item} />
      ) : (
        <GitBranch className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-accent-text' : 'text-subtle')} />
      )}
      <span className="flex min-w-0 items-center gap-1 font-mono text-footnote">
        <span className="shrink-0 text-subtle">{wt.baseBranch || 'HEAD'}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-subtle" />
        <span className={cn('min-w-0 truncate', active ? 'text-fg' : 'text-subtle line-through')} title={wt.path}>
          {wt.branch}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle">
        {item
          ? worktreeSummary(item)
          : !active
            ? wt.state === 'merged'
              ? t('已合并到「{branch}」，分支已删除', { branch: wt.note || wt.baseBranch })
              : t('已删除，改动没有合并')
            : t('在独立分支上执行，不改动项目目录')}
      </span>
      {item && item.state === 'active' && !item.working && (
        <span className="flex shrink-0 items-center gap-1">
          {needsMerge(item) && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7"
              disabled={busy}
              onClick={() => void actions.merge(item)}
            >
              <GitMerge className="h-3.5 w-3.5" />
              {t('合并到「{branch}」', { branch: item.baseBranch || t('原分支') })}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            title={t('删除独立分支')}
            aria-label={t('删除独立分支')}
            className="hover:bg-danger/10 hover:text-danger"
            onClick={() => actions.askRemove(item)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      )}
      {actions.confirm}
    </div>
  )
}

/** 对话的一轮回复：署名用这条回复记下的 CLI 和模型；以前的回复没记，用对话现在的设置 */
/**
 * 流式输出时任务每 200ms 换一个新对象：可见的几十段回复不 memo 的话每次全部重渲染。
 * 跳过重渲染的条件：消息逐条没变、其余参数没变；task 只对最新的那几段严格比较，
 * 更早的回复只看任务身份和会影响它显示的几个字段（状态、独立分支），流式增量不让它们重画
 */
export const sameMsgs = (a: TaskMessage[], b: TaskMessage[]) => a.length === b.length && a.every((m, i) => m === b[i])
export const sameFallback = (a?: ChatRun, b?: ChatRun) =>
  a === b || (!!a && !!b && a.cli === b.cli && a.model === b.model && a.effort === b.effort)
export const ChatTurn = memo(ChatTurnInner, (a, b) => {
  if (!sameMsgs(a.msgs, b.msgs)) return false
  if (a.live !== b.live || a.last !== b.last || a.latest !== b.latest) return false
  if (a.teamNames !== b.teamNames || a.command !== b.command || !sameFallback(a.fallback, b.fallback)) return false
  if (a.task === b.task) return true
  if (b.live || b.last || b.latest || !a.task || !b.task) return false
  return (
    a.task.id === b.task.id &&
    a.task.status === b.task.status &&
    a.task.worktree?.state === b.task.worktree?.state &&
    a.task.worktree?.path === b.task.worktree?.path
  )
})

export function ChatTurnInner({
  msgs,
  task,
  teamNames,
  live,
  last,
  latest,
  fallback,
  command,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live: boolean
  last: boolean
  /** 对话里的最新一轮（和父对话在不在跑无关）：运行区的子对话、后台命令按它列 */
  latest: boolean
  fallback?: ChatRun
  /** 对话任务最近一次启动 Agent 的命令 */
  command?: string[]
}) {
  const run = msgs.find((m) => m.run)?.run
  const cur = useChatRun(fallback ?? { cli: '', model: '', effort: '' }).run
  const author = useRunAuthor(fallback ? (run ?? cur) : undefined)
  // 这一轮实际启动的命令：署名行最右边显示，和工作流节点标题旁的一样；按 Agent 显示的对话没有署名行，交给名字那行
  const withCommand = author ? { ...author, command } : undefined
  return (
    <ChatReply
      msgs={msgs}
      task={task}
      teamNames={teamNames}
      live={live}
      last={last}
      latest={latest}
      fold
      author={withCommand}
      command={withCommand ? undefined : command}
    />
  )
}

/** 回复还没开始输出时的署名：按 CLI 显示的对话用现在选的 CLI 和模型，其他对话用 Agent */
export function PendingReply({
  fallback,
  agentId,
  children,
}: {
  fallback?: ChatRun
  agentId: string
  children: React.ReactNode
}) {
  const { agents } = useData()
  const { modelOf } = useAgentView()
  const cur = useChatRun(fallback ?? { cli: '', model: '', effort: '' }).run
  const byCli = useRunAuthor(fallback ? cur : undefined)
  const a = agents.find((x) => x.id === agentId)
  const author = byCli ?? (a ? { name: a.name, cli: a.cli, icon: a.icon, model: modelOf(a) } : undefined)
  if (!author) return <>{children}</>
  return <PendingAuthor author={author}>{children}</PendingAuthor>
}

/**
 * 这一轮没在跑时状态行：先说清在等什么结果，真的停在等下一句时才说「等待你的下一条消息」。
 * 等用户回答、等确认由对话里的提问卡片表达，这里不重复
 */
export function ChatWaitLine({ wait, awaiting, task }: { wait: ChildWait; awaiting: boolean; task: Task }) {
  if (wait.kind === 'answer' || wait.kind === 'confirm') return null
  // 等下一句要 CLI 真的停在面板工具上等（awaitingUser）：只是预热完、还在启动时不写成在等你
  if (wait.kind === 'next' && !awaiting) return null
  // 文案都用已有的：子任务和工作流这两句和 RunPhase 同源，没有新词
  const text =
    wait.kind === 'helpers'
      ? t('等待 {n} 个子任务完成', { n: wait.list.length })
      : wait.kind === 'background'
        ? t('等 {n} 个后台命令', { n: wait.n })
        : wait.kind === 'workflow'
          ? t('等工作流跑完')
          : t('等待你的下一条消息')
  const next = wait.kind === 'next'
  return (
    <div className="flex items-center gap-2 text-body text-muted" data-chat-wait={wait.kind}>
      {/* 还在等别人的结果：转圈；等你的下一句：对话气泡 + 动态点 */}
      {next ? (
        <MessageSquareText className="h-4 w-4 text-subtle" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
      )}
      <span className="inline-flex items-baseline">
        {text}
        {next && <WaitDots />}
      </span>
      {/* 等下一句时确实空闲（它在等你），等别人的结果时才是「等待中」：不把在干活的对话说成没事做 */}
      <LiveStats task={task} agentIds={[task.agentId]} waiting={!next} />
    </div>
  )
}

/**
 * 执行中的状态文字：最近一段时间没有任何输出、也没有工具在跑，说明在等模型的下一段。
 * 模型请求本身要几秒到几十秒（上下文越大越久），标出来，免得看起来像卡在工具上
 *
 * agentIds 要和同一行 LiveStats 的传法一致：判断「真的在出 token」只能看这一行显示的那几个 Agent，
 * 看全部 Agent 会把「别人在输出、这一轮自己在排队」当成在输出，反而把真排队遮掉
 */
export function RunPhase({ task, label, agentIds }: { task: Task; label: string; agentIds?: string[] }) {
  const now = useNow(true)
  const idle = now - Date.parse(task.updatedAt)
  // 执行中发的补充排在最后：还在跑的命令在它前面那条回复里，不能只看最后一条
  const busy =
    !!task.requests.length ||
    task.messages.slice(-4).some((m) => m.tools.some((x) => x.running || (x.ms === undefined && !!x.startedAt)))
  // 对话派出的子任务还没做完：对话停在这里等它们，结果交回后接着回复
  const helpers = task.steps.filter((s) => helperRunning(s) && s.parentId === '@chat')
  // 这一行确实在出 token（同一行右边显示着速度）：就不是「还没开始」，不能标成在排队
  const streaming = tpsNow(task, agentIds?.every(Boolean) ? agentIds : undefined) > 0
  // API 设置的并发上限满了：这一轮排着队，前面的对话或子任务释放了才开始（输入框照样是停止按钮）。
  // 只看「开跑前就排着」的标记：让出名额后拿回的（等子任务、等下一句）这一轮已经跑起来了，
  // 它排的是「交回结果的那一句」而不是「这一轮」，写成排队会和右边的实时速度自相矛盾
  const wait = apiQueueWait(task, streaming)
  if (wait)
    return (
      <>
        {wait.ahead
          ? t('排队等 API「{api}」空出并发名额 · 前面还有 {n} 个', { api: wait.api, n: wait.ahead })
          : t('排队等 API「{api}」空出并发名额 · 下一个就是这里', { api: wait.api })}
      </>
    )
  if (helpers.length && !busy) return <>{t('等待 {n} 个子任务完成', { n: helpers.length })}</>
  // 等模型也是一种耗时：和别处同一套写法（已 41.2s / 已 2m 5s）
  return <>{busy || streaming || idle < 1500 ? label : t('等待模型 · 已 {wait}', { wait: fmtDuration(idle) })}</>
}
