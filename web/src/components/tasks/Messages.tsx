import { Fragment, memo, useEffect, useRef, useState } from 'react'
import type { AnalysisScope } from '@shared/analysis-home'
import {
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  GitMerge,
  Info,
  Loader2,
  RotateCw,
  SendHorizontal,
  Terminal,
  Workflow,
} from 'lucide-react'
import type { Alert, Task, TaskMessage, ToolUse } from '@shared/schema'
import { makeAlert } from '@shared/alerts'
import { toast } from '@/lib/toast'
import { api } from '@/lib/api'
import { AlertRow } from './AlertRow'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { RowShell, ToolRows } from './ToolRow'
import { fmtDuration } from '@/lib/tasks'
import { addFoldCut, foldCuts, foldStats, keptOut, replyText, segOpenOf, splitFolds, toggleSegOpen } from '@/lib/fold'
import { dedupePeerReports } from '@/lib/peer-dedupe'
import { ChildAskCard } from './ChildAskCard'
import { ReceivedRow } from './PeerMessage'
import { peerOfMessage } from '@shared/peer-message'
import { useChildOpen, useChildList, useRunViewOpen } from './child-open'
import { runRow, type WorkflowRun } from '@/lib/run-row'
import { AnswerMessage, ReplyFrame } from '@/components/chat/ChatMessage'
import { Markdown } from './Markdown'
import { stripNext } from '@shared/builtin/default'
import { convStateText, deliveryText } from '@shared/task'
import { stripDispatch } from '@shared/dispatch'
import { stripEvolution } from '@shared/task-export'
import { stripLessonReview } from '@shared/lesson-review'
import { stripInitJson } from '@/lib/analysis-report'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { StepCommand } from './StepCommand'
import { RunningNow, runningRows, runningTools } from './RunningNow'
import { useAgentView } from '@/lib/agent-view'
import { conversationAround } from '@shared/fix'
import { useNow } from '@/lib/useNow'
import { t } from '@shared/i18n'

/** 最后一个满足条件的下标（目标库没有 findLastIndex） */
function lastIndex<T>(list: T[], ok: (x: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return i
  return -1
}

export function SystemNote({
  text,
  error,
  alert,
  className,
  conversation,
  cwd,
  home,
}: {
  text: string
  error?: boolean
  /** 报错、警告的分类和原始信息；旧数据只有 error 时按正文归类 */
  alert?: Alert
  className?: string
  /** 报错前后的对话：交给 AI 时一起带上，它才知道出错时在做什么 */
  conversation?: string
  /** 报错所在的项目目录 */
  cwd?: string
  /** 报错属于哪个对话：「AI 处理」按它定分析对话开在哪 */
  home?: AnalysisScope
}) {
  // 报错和警告都画成带底色的一行，点开看这是什么、怎么办和原始信息（见 shared/alerts.ts）。
  // className 是给居中的说明用的，不传给它：点开的说明要左对齐
  if (alert || error)
    return (
      <AlertRow
        alert={alert ?? makeAlert('error', text)}
        text={text}
        conversation={conversation}
        cwd={cwd}
        home={home}
      />
    )
  return (
    <div className={cn('flex items-start gap-1.5 text-xs leading-relaxed whitespace-pre-wrap text-subtle', className)}>
      <span className="flex h-[1.625em] shrink-0 items-center">
        <Info className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </div>
  )
}

/**
 * 对话里的系统消息：用户对提问的回答像用户消息一样显示在正文里，其他的是一行说明。
 * 报错的「AI 处理」带上这条所在的对话（前后几条）和项目路径，AI 才看得出出错时在做什么
 */
export function NoteMessage({
  m,
  msgs,
  task,
  className,
}: {
  m: TaskMessage
  /** 整个对话：出错时把这条前后的几条一起交给 AI */
  msgs?: TaskMessage[]
  /** 任务：出错时带上项目路径（独立分支里执行时是分支目录） */
  task?: Task
  className?: string
}) {
  const { projects } = useData()
  // 计划启动时写进对话的那条提示：只是把计划输入又抄了一遍，用户知道自己让 Agent 干了什么，不画出来。
  // 按消息上的标记判断，不看文案——用户自己打的字里也可能出现「开始执行计划」
  if (m.planStart) return null
  if (m.answers?.length) return <AnswerMessage answers={m.answers} at={m.at} />
  const around = msgs && (m.error || m.alert) ? conversationAround(msgs, msgs.indexOf(m)) : ''
  const cwd =
    task?.worktree?.state === 'active'
      ? task.worktree.path
      : (projects.find((p) => p.id === task?.projectId)?.path ?? '')
  return (
    <SystemNote
      text={m.text}
      error={m.error}
      alert={m.alert}
      className={className}
      conversation={around}
      cwd={cwd}
      home={task ? { kind: 'task', task } : undefined}
    />
  )
}

/**
 * 执行中发的消息去了哪里：用户气泡底部一行小字，写的是用户能看懂的事实（插进当前轮 / 排到下一轮 / 结束后自动处理），
 * 不直接把内部枚举值摆出来（见 shared/task.ts 的 deliveryText）。对话页和工作流节点都读这一份
 */
export function DeliveryLine({ delivery }: { delivery: NonNullable<TaskMessage['delivery']> }) {
  const text = deliveryText(delivery.how)
  if (!text) return null
  return (
    <span
      className={cn(
        'mt-1.5 flex items-center gap-1 text-[0.75rem]',
        // 没送出去的需要用户重发：和其他交付状态一样的灰色会被滑过去
        delivery.how === 'lost' ? 'text-warning' : 'text-subtle',
      )}
    >
      <SendHorizontal className="h-3 w-3 shrink-0" />
      {text}
    </span>
  )
}

/** 这一轮模型请求用了多久：两步之间看起来在等的时间基本都在这里 */
function ModelTime({ ms }: { ms: number }) {
  return <span className="text-xs text-subtle tabular-nums">{t('模型 {time}', { time: fmtDuration(ms) })}</span>
}

/**
 * 思考过程：正在思考时展开并跟随最新内容，思考结束（开始输出回复）后自动收起成一行，可以点开看完整内容
 */
function Thinking({ text, live, ms, thinkingMs }: { text: string; live: boolean; ms?: number; thinkingMs?: number }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const shown = open ?? live
  useEffect(() => {
    if (live && shown && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [text, live, shown])
  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setOpen(!shown)}
        aria-expanded={shown}
        className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-xs text-subtle hover:text-muted"
      >
        <Brain className={cn('h-3.5 w-3.5', live && 'animate-pulse text-accent')} />
        <span className={cn(live && 'thinking-shimmer')}>{live ? t('正在思考…') : t('思考过程')}</span>
        {!live && thinkingMs !== undefined && <span className="tabular-nums">{fmtDuration(thinkingMs)}</span>}
        {!live && !!ms && <ModelTime ms={ms} />}
        <ChevronRight className={cn('h-3 w-3 transition-transform', shown && 'rotate-90')} />
      </button>
      {shown && (
        <div
          ref={box}
          className={cn(
            'border-l-2 border-line-strong pl-3 text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]',
            live && 'max-h-40 overflow-y-auto',
          )}
        >
          {text.trim()}
        </div>
      )}
    </div>
  )
}

export type Author = {
  name: string
  cli: string
  icon?: string
  model?: string
  /** 启动这条回复的 CLI 命令：署名行最右边给个小按钮，点开看完整命令 */
  command?: string[]
}

export function AgentMessage({
  m,
  task,
  teamNames,
  compact,
  live,
  hideProcess,
  hideAuthor,
  slot,
  slotKey,
  author,
  command,
}: {
  m: TaskMessage
  /** 工具行的窗口要拿任务里的改动信息（编辑记录没有的话可以看任务级的差异） */
  task?: Task
  teamNames: Set<string>
  compact?: boolean
  /** 这条消息正在流式输出 */
  live?: boolean
  /** 只显示回复文字，思考和工具收在外面的折叠里 */
  hideProcess?: boolean
  /** 名字和模型由外面统一显示（对话一轮的吸顶署名） */
  hideAuthor?: boolean
  /** 放在名字下面、回复上面的内容（折叠起来的过程） */
  slot?: React.ReactNode
  /** slot 的内容签名：slot 每次都是新画的元素，按引用比较会让这条消息每次都重渲染 */
  slotKey?: string
  /** 不是某个 Agent 说的（例如「AI 创建」里直接调用的 CLI）：显示这个名字和 CLI 颜色 */
  author?: Author
  /** 启动这条回复的命令：没有 author 时（按 Agent 显示的对话）用这个 */
  command?: string[]
}) {
  const { modelOf } = useAgentView()
  const { agents } = useData()
  const a = author ? undefined : agents.find((x) => x.id === m.agentId)
  const text = replyText(m)
  return (
    <MessageBody
      m={text === m.text ? m : { ...m, text }}
      task={task ? { id: task.id, status: task.status, changes: task.changes, jobs: task.jobs } : undefined}
      teamNames={teamNames}
      compact={compact}
      live={live}
      hideProcess={hideProcess}
      hideAuthor={hideAuthor}
      slot={slot}
      slotKey={slotKey}
      name={author?.name ?? a?.name ?? t('已删除的角色')}
      model={author ? author.model : a ? modelOf(a) : undefined}
      icon={a || author ? (a?.icon ?? author!.icon ?? 'sparkles') : undefined}
      cli={a?.cli ?? author?.cli ?? ''}
      command={author?.command ?? command}
    />
  )
}

/** 启动命令是数组：任务推送时每次都是新对象，比较按内容 */
const commandSig = (command?: string[]) => command?.join('\u0000') ?? ''

/** 工具行只用到任务的这几样：不把整个任务（含上千条消息）传进每条回复 */
type ToolTask = Pick<Task, 'id' | 'status' | 'changes' | 'jobs'> & { analysis?: Task['analysis'] }

/** 后台命令的状态：跑完时放到后台的那一行要停止转圈 */
const jobsSig = (task?: ToolTask) => task?.jobs?.map((j) => `${j.id}:${j.state}`).join(',') ?? ''

type BodyProps = {
  m: TaskMessage
  task?: ToolTask
  teamNames: Set<string>
  compact?: boolean
  live?: boolean
  hideProcess?: boolean
  hideAuthor?: boolean
  slot?: React.ReactNode
  /** slot 的内容签名：比较函数按它判断要不要重画 */
  slotKey?: string
  name: string
  model?: string
  /** 没有时显示空白头像（Agent 已删除） */
  icon?: string
  cli: string
  /** 启动这条回复的命令：名字那行最右边显示 */
  command?: string[]
}

/** 消息内容会变的部分：文字、思考长度、模型耗时和每个工具调用的结果 */
// 工具输出在跑的时候服务端只留最后一段（长度到了上限就不再变），只比长度会漏掉更新：
// 再带上末尾几十个字、是否还在跑和摘要，命令窗口和行内输出才会跟着刷新
const toolSig = (x: TaskMessage['tools'][number]) =>
  `${x.output?.length ?? 0}:${x.output?.slice(-48) ?? ''}${x.failed ? '!' : ''}${x.running ? '~' : ''}:${x.ms ?? ''}:${x.detail}:${x.input?.length ?? 0}`
const sig = (m: TaskMessage) =>
  `${m.id}|${m.text.length}|${m.thinking?.length ?? 0}|${m.modelMs ?? 0}|${m.thinkingMs ?? 0}|${m.tools.map(toolSig).join(',')}`

/**
 * 角色名后面的 Agent（CLI）名：同一个角色换了 CLI 时跟着变，一眼看出这条回复是哪个 CLI 跑的。
 * 按 Agent 显示的对话里名字本来就是 CLI 名，再显示一次只是重复
 */
function CliLabel({ cli, name }: { cli: string; name: string }) {
  const { cliName } = useAgentView()
  const label = cliName({ cli })
  if (name.startsWith(label)) return null
  return <span className="shrink-0 text-xs text-subtle">{`· ${label}`}</span>
}

/** 对话一轮的署名栏：滚到顶部后固定，下一次署名前被顶走 */
function StickyAuthor({ author }: { author: Author }) {
  return (
    <div className="sticky top-0 z-10 -mx-2 flex items-center gap-3 bg-bg px-2 py-2">
      <AgentAvatar icon={author.icon ?? 'sparkles'} cli={author.cli} size="sm" />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[0.8125rem]">
        <span className="shrink-0 font-medium">{author.name}</span>
        <CliLabel cli={author.cli} name={author.name} />
        {/* 窄的时候先压缩模型这一段，名字和 Agent 名不被截成一半 */}
        {author.model && <span className="min-w-0 truncate font-mono text-xs text-subtle">{author.model}</span>}
      </div>
      {/* 启动命令和工作流节点标题旁的一样，只放图标，点开看完整命令 */}
      {author.command?.length ? <StepCommand argv={author.command} className="ml-auto -my-1" /> : null}
    </div>
  )
}

/** 回复还没开始输出时的占位：发出消息马上显示是谁在回复、用的模型，下面放进度 */
export function PendingAuthor({ author, children }: { author: Author; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <StickyAuthor author={author} />
      <div className="flex gap-3">
        <span className="w-[26px] shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
      </div>
    </div>
  )
}

/**
 * 每次轮询拿到的都是新的任务对象，长任务有上千条消息时全部重新渲染（Markdown、代码高亮）会很卡。
 * 只在这条消息的内容或显示方式变了时才重新渲染
 */
const MessageBody = memo(
  function MessageBody({
    m,
    task,
    teamNames,
    compact,
    live,
    hideProcess,
    hideAuthor,
    slot,
    name,
    model,
    icon,
    cli,
    command,
  }: BodyProps) {
    const noHeader = !!compact || !!hideAuthor
    return (
      <div data-msg={m.id} className="flex gap-3">
        {noHeader ? (
          <span className="w-[26px] shrink-0" />
        ) : icon ? (
          <AgentAvatar icon={icon} cli={cli} size="sm" />
        ) : (
          <span className="h-[26px] w-[26px] shrink-0 rounded-[7px] bg-field" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {!noHeader && (
            <div className="flex items-center gap-2 pt-0.5 text-[0.8125rem]">
              <span className="shrink-0 font-medium">{name}</span>
              <CliLabel cli={cli} name={name} />
              {/* 窄的时候先压缩模型这一段，名字和 Agent 名不被截成一半 */}
              {model && <span className="min-w-0 truncate font-mono text-xs text-subtle">{model}</span>}
              {/* 启动命令和工作流节点标题旁的一样，只放图标，点开看完整命令 */}
              {command?.length ? <StepCommand argv={command} className="ml-auto -my-1" /> : null}
            </div>
          )}
          {slot}
          {!hideProcess && m.thinking?.trim() && (
            <Thinking
              text={m.thinking}
              live={!!live && !m.text.trim() && !m.tools.length}
              ms={m.modelMs}
              thinkingMs={m.thinkingMs}
            />
          )}
          {!hideProcess && !m.thinking?.trim() && !!m.modelMs && <ModelTime ms={m.modelMs} />}
          {!hideProcess && m.tools.length > 0 && (
            <div className="flex flex-col gap-1">
              <ToolRows tools={m.tools} task={task} />
            </div>
          )}
          {m.text && (
            <Markdown
              text={(task?.analysis === 'init' ? stripInitJson : (x: string) => x)(
                stripLessonReview(stripEvolution(stripDispatch(stripNext(m.text)))),
              )}
              teamNames={teamNames}
              live={live}
            />
          )}
        </div>
      </div>
    )
  },
  (a, b) =>
    // slot 是每次新画的元素：按内容签名比，内容没变就不重画整段回复
    (a.slot === b.slot || (!!a.slotKey && a.slotKey === b.slotKey)) &&
    sig(a.m) === sig(b.m) &&
    a.teamNames === b.teamNames &&
    a.compact === b.compact &&
    a.live === b.live &&
    a.hideProcess === b.hideProcess &&
    a.hideAuthor === b.hideAuthor &&
    a.name === b.name &&
    a.model === b.model &&
    a.icon === b.icon &&
    a.cli === b.cli &&
    // 启动命令是数组，任务推送时每次都是新对象，按内容比
    commandSig(a.command) === commandSig(b.command) &&
    // 工具行的窗口只用到任务的 id、状态和有哪些改动的文件：任务对象和改动列表每个增量都会换，
    // 不能按引用比较，否则整段回复每 200ms 都要重画 Markdown。差异窗口打开时会自己按当前内容取，
    // 工具输出的变化也已经在 sig 里比较过了
    a.task?.id === b.task?.id &&
    a.task?.status === b.task?.status &&
    (a.task?.changes?.length ?? 0) === (b.task?.changes?.length ?? 0) &&
    // 后台命令跑完时这一行要停止转圈
    jobsSig(a.task) === jobsSig(b.task),
)

/**
 * 面板推回给 CLI 的消息（后台命令、合并编译、子任务的结果）和父子对话之间的往来（子对话状态、收尾请求）：
 * 都画成 AI 回复里的一行，像一次工具调用，点开看全文
 */
const PANEL_KIND = {
  background: { icon: Terminal, verb: () => t('后台命令') },
  build: { icon: GitMerge, verb: () => t('合并编译') },
  helpers: { icon: Bot, verb: () => t('子任务结果') },
  child: { icon: Workflow, verb: () => t('子对话状态') },
  wrapup: { icon: GitMerge, verb: () => t('子对话请求') },
  note: { icon: Info, verb: () => t('设置') },
} as const

/** 正文开头的【面板】【子对话状态】这类标签是说给 AI 的，界面上第一行不重复它 */
const LEAD_TAG = /^【[^】]{1,12}】/

function PanelRow({ m, teamNames }: { m: TaskMessage; teamNames: Set<string> }) {
  const [open, setOpen] = useState(false)
  const openChild = useChildOpen()
  const kind = PANEL_KIND[m.panel === 'ask' || !m.panel ? 'background' : m.panel]
  const Icon = kind.icon
  // 结尾那句「处理完这个结果后重新总结」是说给 AI 的，界面上不显示
  const body = m.text
    .replace(LEAD_TAG, '')
    .replace(/\n处理完这个结果后[^\n]*$/, '')
    .trim()
  // 一行里放第一句：后台命令「名字」跑完了：失败……；子任务结果放交回了几个；
  // 子对话状态放「标题 · 状态」（新数据带 child，旧数据按第一行）
  const head =
    m.panel === 'helpers'
      ? t('{n} 个子任务交回了结果', { n: Math.max(1, (body.match(/^### /gm) ?? []).length) })
      : m.child && m.panel === 'child'
        ? [m.child.title, convStateText(m.child.state)].filter(Boolean).join(' · ')
        : body
            .split('\n')[0]
            .replace(/^(后台命令|合并编译)/, '')
            .trim()
  const failed =
    m.panel === 'child'
      ? m.child?.state === 'failed'
      : m.panel !== 'helpers' && /跑完了：失败|被停止了|没通过|没能合回/.test(body.split('\n')[0])
  // 停下时独立分支里还有没提交的改动：行上（不用点开）就写清几个文件、目录在哪，并给一键继续
  const wt = m.worktree
  return (
    <RowShell
      glyph={<Icon className={cn('h-3.5 w-3.5 shrink-0', failed ? 'text-danger' : 'text-subtle')} />}
      verb={m.panel === 'child' && !m.child ? t('对话消息') : kind.verb()}
      title={head}
      open={open}
      detail={
        wt ? (
          <>
            <span className="shrink-0 text-[0.6875rem] text-warning" title={wt.path}>
              {t('{n} 个文件未提交', { n: wt.dirty })}
            </span>
            {m.child?.id && <ResumeChild id={m.child.id} />}
          </>
        ) : undefined
      }
      // 一句话的说明（执行中改设置）没有更多可看的，不能展开
      onToggle={body.includes('\n') || m.panel !== 'note' ? () => setOpen(!open) : undefined}
      onOpen={m.child && openChild ? () => openChild(m.child!.id) : undefined}
      openTip={m.child ? t('打开子对话') : undefined}
      failed={failed}
    >
      <div className="max-h-[min(50vh,420px)] overflow-y-auto border-t px-3 py-2.5 text-[0.8125rem]">
        <Markdown text={body} teamNames={teamNames} />
      </div>
    </RowShell>
  )
}

/**
 * 停下的子对话一键继续：重新占执行位、从停下的地方接着做（和子对话自己页面的「继续执行」同一个接口）。
 * 按钮放在这一行的尾部，点它不能顺带展开 / 收起整行
 */
function ResumeChild({ id }: { id: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        setBusy(true)
        api
          .resumeTask(id)
          .then(
            () => toast.success(t('已让它接着做')),
            // 这一行是停下来那一刻的历史记录：它后来可能已经被继续或做完了，服务端会拒（409），
            // 拒的时候说清现在的情况，别把「只有失败或停止的任务可以继续」直接摊给用户
            (err: Error & { status?: number }) =>
              toast.error(err.status === 409 ? t('它已经不在停下了，可能已经继续或者做完了') : err.message),
          )
          .finally(() => setBusy(false))
      }}
      title={t('让它接着做：重新占执行位，从停下的地方继续')}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[0.6875rem] text-accent hover:bg-sel disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
      {t('继续')}
    </button>
  )
}

/**
 * 夹在 AI 回复里、不是谁说的话的几种消息：面板推回的结果、子对话的提问。
 * 和工具调用一样缩进在头像后面；不是这几种返回 null
 */
function inlineEntry(m: TaskMessage, task: Task | undefined, teamNames: Set<string>) {
  // 派出的子任务在输入框上方的「子任务」栏里看：消息流里不再画卡片，
  // 这条消息只用来记派出了哪几个，已完成的那一轮折叠行上仍写着「派出 n 个子任务」
  if (m.spawned?.length) return <Fragment key={m.id} />
  const body =
    m.panel === 'ask' && m.ask ? (
      <ChildAskCard m={m} task={task} teamNames={teamNames} />
    ) : peerOfMessage(m) ? (
      // 另一个对话发来的（任务、上报、收尾、编译、传话）：统一画成「接收消息」
      <ReceivedRow m={m} />
    ) : m.panel ? (
      <PanelRow m={m} teamNames={teamNames} />
    ) : null
  if (!body) return null
  return (
    <div key={m.id} className="flex gap-3">
      <span className="w-[26px] shrink-0" />
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  )
}

/** 这条消息不打断同一个 Agent 的连续回复（下一条不用再显示名字）：面板结果和派出子任务的那条 */
const transparent = (m: TaskMessage) => !!m.panel || !!m.peer || !!m.spawned?.length

/** 一串消息按顺序显示；同一个 Agent 连续的消息只显示一次头像和名字 */
export function Msgs({
  msgs,
  task,
  teamNames,
  live,
  slot,
  slotKey,
  author,
  command,
  compactFirst,
  hideAuthor,
  stickyAuthor,
  lead,
  tail,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live?: boolean
  /** 放在第一条 Agent 消息名字下面的内容（展开后的折叠开关） */
  slot?: React.ReactNode
  /** slot 的内容签名（同 AgentMessage） */
  slotKey?: string
  author?: Author
  /** 启动这些回复的命令 */
  command?: string[]
  /** 这段前面已经显示了同一个 Agent 的名字：第一条不再重复 */
  compactFirst?: boolean
  /** 名字和模型由外面统一显示（对话一轮的吸顶署名） */
  hideAuthor?: boolean
  /** 名字行吸顶：对话里滚到回复中部时还能看到是谁、用的什么模型 */
  stickyAuthor?: boolean
  /** 放在所有消息前面、署名栏后面的一行（第一条不是 Agent 消息时的折叠开关） */
  lead?: React.ReactNode
  /** 放在所有消息后面（运行区挂在总结下面，不是插在回复中间） */
  tail?: React.ReactNode
}) {
  const lastAgent = lastIndex(msgs, (m) => m.role === 'agent')
  const firstAgent = msgs.findIndex((m) => m.role === 'agent')
  const { agents } = useData()
  const { modelOf } = useAgentView()
  // 署名行必须放在整段输出外面：放在单条消息里时，sticky 的包含块只有那一条消息的高度，
  // 滚过去就跟着滚出视口了（按 CLI 显示的对话 StickyAuthor 在整轮外面，所以不受影响）
  const firstMsg = firstAgent >= 0 ? msgs[firstAgent] : undefined
  const sticky = !author && stickyAuthor && !compactFirst && firstMsg && agents.find((x) => x.id === firstMsg.agentId)
  return (
    <>
      {sticky && (
        <StickyAuthor
          author={{ name: sticky.name, cli: sticky.cli, icon: sticky.icon, model: modelOf(sticky), command }}
        />
      )}
      {lead && (
        <div className="flex gap-3">
          <span className="w-[26px] shrink-0" />
          <div className="min-w-0 flex-1">{lead}</div>
        </div>
      )}
      {msgs.map((m, k) => {
        const inline = inlineEntry(m, task, teamNames)
        if (inline) return inline
        if (m.role === 'system') return <NoteMessage key={m.id} m={m} msgs={msgs} task={task} />
        // 前面隔着子任务、面板结果时仍算同一段回复：不再重复名字
        let j = k - 1
        while (j >= 0 && transparent(msgs[j])) j--
        return (
          <AgentMessage
            key={m.id}
            m={m}
            task={task}
            teamNames={teamNames}
            live={live && k === lastAgent}
            slot={k === firstAgent ? slot : undefined}
            slotKey={k === firstAgent ? slotKey : undefined}
            author={author}
            command={command}
            hideAuthor={hideAuthor || (!!sticky && k === firstAgent)}
            compact={j < 0 ? !!compactFirst : msgs[j].role === 'agent' && msgs[j].agentId === m.agentId}
          />
        )
      })}
      {tail}
    </>
  )
}

/** 还在跑的行前面的转圈图标：和后台命令、子对话用同一套外观 */
const spinning = <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />

/**
 * 运行区里的工作流运行（计划触发的那次、工作流任务自己跑的那次都一样）：和后台命令一样放在总结下面，
 * 没跑完就一直转圈，右边写做到第几个节点，点整行打开这次运行的视图；
 * 完成后从这行消失，失败或被停止时留一行说明和失败的节点，不悄无声息地不见了。
 * 要不要画已经在 runRow 里判过，这里只按拿到的数据画
 */
function RunRow({ info }: { info: WorkflowRun }) {
  const [open, setOpen] = useState(false)
  const openRun = useRunViewOpen()
  const running = info.status === 'running'
  // 跑的时候每秒刷新已经用了多久，和后台命令一样
  const now = useNow(!!running)
  // 整行都是打开入口：点哪里都进这次运行的视图，和运行卡片上的「打开这次运行的对话」是同一个地方
  const openView = openRun ? () => openRun(info.run) : undefined
  const line = running ? (
    <RowShell
      glyph={spinning}
      verb={t('工作流')}
      title={info.name}
      detail={
        <span className="shrink-0 font-sans text-subtle">
          {info.total ? t('{done}/{total} 个节点', { done: info.done, total: info.total }) : t('正在准备节点…')}
        </span>
      }
      ms={info.startedAt ? now - Date.parse(info.startedAt) : undefined}
      open={false}
      rowOpen={openView}
      onOpen={openView}
      openTip={t('打开这次运行的对话')}
    />
  ) : (
    <RowShell
      glyph={
        <CircleAlert className={cn('h-3.5 w-3.5 shrink-0', info.status === 'failed' ? 'text-danger' : 'text-subtle')} />
      }
      verb={t('工作流')}
      title={info.name}
      detail={
        <span className="shrink-0 font-sans text-subtle">
          {info.status === 'stopped' ? t('已停止') : t('{n} 个节点失败', { n: info.failed.length })}
        </span>
      }
      // 还没节点失败（被停止）时没有可看的，点不动。
      // 这里不用 rowOpen 打开运行视图（和还在跑那一行不同）：失败 / 被停止的时候用户要看的是
      // 哪几个节点挂了，点了先展开这些节点；运行视图本身在下面的运行卡片里也能进
      onToggle={info.failed.length ? () => setOpen(!open) : undefined}
      open={open}
      failed={info.status === 'failed'}
    >
      <div className="flex flex-col gap-0.5 border-t px-3 py-2 text-[0.8125rem]">
        {info.failed.map((s) => (
          <span key={s.id} className="truncate text-danger">
            {s.title}
          </span>
        ))}
      </div>
    </RowShell>
  )
  return line
}

/**
 * 总结下面那一块「还在跑的东西」：上面一条细分割线，下面列运行区（子对话、子任务、后台命令、
 * 没在跑的工具、工作流运行）。
 *
 * 分割线必须和内容在同一个判断里：两者都靠 runningRows / runRow 算出来的「到底有没有东西」，
 * 没东西时整个 footer 返回 null，不会在总结下面留一条孤零零的横线。
 */
export function RunningFooter({
  task,
  msgs,
  live,
  tools,
  jobs,
  kids,
  last,
  latest,
  isTail,
}: {
  task?: Task
  /** 这一轮的消息：工作流那一行靠它认是不是最新的一轮 */
  msgs: TaskMessage[]
  /** 这一段还在流式输出：工具就在过程里转圈，不重复列 */
  live?: boolean
  /** 这一段里还没收尾的工具调用 */
  tools: ToolUse[]
  jobs: boolean
  kids: boolean
  /** 最新的一轮 */
  last?: boolean
  /** 对话里的最新一轮（跳过尾部刚发出的用户消息，见 latest-turn） */
  latest?: boolean
  /** 这一段是一轮里最新的一段：工作流那一行只挂在它下面，旧段不重复列 */
  isTail?: boolean
}) {
  const children = useChildList()
  // 列什么只算一次，判空和渲染读同一个值：以前判空用 tools、渲染传 live ? [] : tools，
  // 两个表达式能分叉（live 且 tools 非空时判空说「有内容」、RunningNow 却返回 null），
  // 总结下面就会出现一条没有内容的横线
  const shownTools = live ? [] : tools
  const rows = runningRows({ task, tools: shownTools, jobs, kids, children })
  // 工作流那一行和子对话、后台命令一样只在最新的一轮上列：latest 已经跳过尾部刚发出的用户消息，
  // 只看 last 的话，发送的一瞬间它也会跟着消失，AI 开始输出再回来。
  // 别的调用方（辅助对话、设计对话）没有 latest，仍然只按 last 判
  const newest = !!last || !!latest
  // 工作流那一行画什么、画不画都在这一个值里（runRow 同时管运行状态和「最新的一轮」）
  const run = isTail ? runRow(task, msgs, newest) : undefined
  // 没东西就整个不画：分割线和内容同一个判断，不会在总结下面留一条孤零零的横线
  if (rows.empty && !run) return null
  const box = (
    // 和总结之间用一条细线分开（低对比度，和面板里其他分割线一致）：
    // 之前运行区插在总结上面，看不出哪段是总结、哪段是还在跑的东西
    <div className="flex flex-col gap-1.5 border-t border-line/60 pt-1.5" role="group" aria-label={t('运行区')}>
      <RunningNow task={task} tools={shownTools} jobs={jobs} kids={kids} />
      {run && <RunRow info={run} />}
    </div>
  )
  return (
    // 总是缩进在头像后（和工具调用、总结文字同一个左边缘）：运行区挂在 Msgs 的 tail，
    // 外面已经没有任何缩进层了，这里不缩就会比总结文字往左突出 26+12px，
    // 分割线也从容器最左端开始，和总结对不上
    <div className="flex gap-3">
      <span className="w-[26px] shrink-0" />
      <div className="min-w-0 flex-1">{box}</div>
    </div>
  )
}

/**
 * 一段完成的输出（一个节点、一轮对话）：思考、工具调用、中间的说明、派出的子任务和面板推回的结果都收进一个折叠，
 * 折叠行上写这段过程做了什么，下面只留最后的回复，和 Claude Code 一样；执行中的那段照常流式显示，
 * 回复一完成就自动收起。报错和子对话的提问不收：报错要让人看到，提问要人回答
 */
export function FoldedRun({
  msgs,
  task,
  teamNames,
  live,
  author,
  command,
  hideAuthor,
  stickyAuthor,
  running,
  foldId,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live?: boolean
  author?: Author
  /** 启动这些回复的命令 */
  command?: string[]
  /** 名字和模型由外面统一显示（对话一轮的吸顶署名） */
  hideAuthor?: boolean
  /** 展开时名字行吸顶（按 Agent 显示的对话） */
  stickyAuthor?: boolean
  /** 还在运行的工具、后台命令和子对话：放在这一段最后的消息（总结）下面，不收进折叠 */
  running?: React.ReactNode
  /** 这一段在一轮里的标识（`轮 key#第几段`）：展开 / 收起的状态按它记，重新挂载、来新内容都不会被打回收起 */
  foldId?: string
}) {
  const [open, setOpen] = useState(() => (foldId ? segOpenOf(foldId) : false))
  // 折叠段的 id 列表：按内容签名缓存（见下面 toggle 的说明）
  const foldIds = useRef({ key: '', value: '' })
  const { agents } = useData()
  const { modelOf } = useAgentView()
  const all = (
    <Msgs
      msgs={msgs}
      task={task}
      teamNames={teamNames}
      live={live}
      author={author}
      command={command}
      hideAuthor={hideAuthor}
      stickyAuthor={stickyAuthor}
    />
  )
  // 折叠行只统计这一段里的操作：一段收尾后又来了新内容时，前面几段各自折一行，不会重复计数
  const { last, parts, failed } = foldStats(msgs)
  // 没有可折的过程：还在运行的东西接在回复后面（和工具调用一样缩进在头像后面）
  if (live || last < 0 || !parts.length)
    return (
      <>
        {all}
        {running}
      </>
    )
  const before = msgs.slice(0, last)
  // 搜索跳转要知道「目标在哪一段」（见 message-anchor）：把这一段的 id 挂在开关上。
  // 直接每次渲染都 join 会在长对话里每 200ms 拼一次上千个 id（实测会拖慢渲染），所以按内容签名缓存：
  // 流式输出时末尾消息还是同一条，签名不变就沿用上次的字符串（引用也不变，React 比属性时直接命中）
  const idsKey = `${msgs.length}|${msgs[0]?.id ?? ''}|${msgs[msgs.length - 1]?.id ?? ''}`
  if (foldIds.current.key !== idsKey) foldIds.current = { key: idsKey, value: msgs.map((m) => m.id).join(' ') }
  // 折叠开关只跟自己：它放在第一条回复的名字下面，不跟运行区一起挪（运行区已经到总结下面了）
  const toggle = (
    <button
      data-fold-msgs={foldIds.current.value}
      onClick={() => setOpen(foldId ? toggleSegOpen(foldId) : !open)}
      aria-expanded={open}
      title={open ? t('收起过程') : t('展开过程')}
      className="flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-subtle hover:text-muted"
    >
      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      <span className="truncate">{parts.join(' · ')}</span>
      {failed > 0 && <span className="shrink-0 text-danger">{t('{n} 次失败', { n: failed })}</span>}
    </button>
  )
  // 折叠开关每次都是新画的元素：给内容算个签名，内容没变时整段回复不重画
  // （运行区已经不在 slot 里了，它挂在 Msgs 的 tail，不影响这条消息的重渲染判断）
  const toggleKey = `${parts.join('·')}|${failed}|${open ? 1 : 0}`
  if (open)
    return (
      // 展开后开关仍然放在第一条回复的名字下面，不跑到名字上方；
      // 回复是从子任务、面板结果开始的，开关放在最前面，不夹在过程中间；
      // 运行区挂在所有消息后面（总结下面），用 tail 插进去，不跟开关挤在一起
      <Msgs
        msgs={msgs}
        task={task}
        teamNames={teamNames}
        slot={msgs[0].role === 'agent' ? toggle : undefined}
        slotKey={toggleKey}
        lead={msgs[0].role === 'agent' ? undefined : toggle}
        tail={running}
        author={author}
        command={command}
        hideAuthor={hideAuthor}
        stickyAuthor={stickyAuthor}
      />
    )
  // 收起时：报错和提问照常显示，其余的过程收起来，最后一条回复带上名字和折叠行显示
  const tail = msgs.slice(last + 1)
  // 名字行要吸顶时和展开时一样放在整段外面（理由见 Msgs）
  const sticky = !author && stickyAuthor && agents.find((x) => x.id === msgs[last].agentId)
  return (
    <>
      {sticky && (
        <StickyAuthor
          author={{ name: sticky.name, cli: sticky.cli, icon: sticky.icon, model: modelOf(sticky), command }}
        />
      )}
      {before
        .filter(keptOut)
        .map(
          (m) =>
            inlineEntry(m, task, teamNames) ??
            (m.role === 'system' && <NoteMessage key={m.id} m={m} msgs={msgs} task={task} />),
        )}
      <AgentMessage
        m={msgs[last]}
        task={task}
        teamNames={teamNames}
        hideProcess
        hideAuthor={hideAuthor || !!sticky}
        slot={toggle}
        slotKey={toggleKey}
        author={author}
        command={command}
      />
      <Msgs
        msgs={tail}
        task={task}
        teamNames={teamNames}
        author={author}
        command={command}
        hideAuthor={hideAuthor || !!sticky}
        compactFirst={tail[0]?.role === 'agent' && tail[0].agentId === msgs[last].agentId}
        tail={running}
      />
    </>
  )
}

/**
 * 通用对话里的一轮回复（工作流以外的 AI 对话都用它）：思考、工具调用和说明按发生的顺序流式显示，
 * 传了 fold 时回复完成后收进一个折叠（项目对话、UI 设计的 AI 对话都传）；完成后下面是时间、复制和各个对话自己的操作
 */
export function ChatReply({
  msgs,
  task,
  teamNames,
  live,
  author,
  command,
  actions,
  last,
  latest,
  fold,
  children,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live?: boolean
  /**
   * 回复完成后思考、工具调用和中间的说明收进一个折叠，和 Claude Code 一样（项目对话、UI 设计的 AI 对话都用）。
   * 不传时整轮过程一路平铺，只给不想折叠的调用方用
   */
  fold?: boolean
  author?: Author
  /** 启动这一轮的命令：按 Agent 显示的对话没有 author，用这个显示在名字那行最右边 */
  command?: string[]
  actions?: React.ReactNode
  /** 最后一轮：操作一直显示 */
  last?: boolean
  /**
   * 对话里的最新一轮（和父对话自己在不在跑无关）：
   * 运行区的子对话按它列。以前直接用 last，而 last 含「父对话没在跑」，
   * 于是父对话自己在跑时运行区整段不渲染，子对话一条也列不出来。
   */
  latest?: boolean
  /** 回复下面、时间上面的内容（例如需要的图片、AI 问的问题） */
  children?: React.ReactNode
}) {
  // 旧数据里同一个子对话的同一份汇报被写了两遍：这一轮显示前先收成一条（见 peer-dedupe）
  const list = dedupePeerReports(msgs)
  // 这一轮收尾时折到第几条消息：之后子对话的回报、后台命令结果又进来、CLI 被重新拉起来时，
  // 前面那段保持折叠，新过程接在它的最后一条回复后面继续显示，不把整轮重新铺开
  const key = list[0]?.id ?? ''
  const [cuts, setCuts] = useState<number[]>(() => foldCuts(key))
  useEffect(() => {
    // 不是执行中就记下收尾位置：第一次画出来就已经收尾（刷新、切回页签、被下面的计划卡片挤成非最后一段）
    // 也要记，否则之后子对话回报把它重新拉起来接着输出时，前面这段会被当成执行中整段铺开。
    // 记录不会重复：位置没往前走时 addFoldCut 返回原来的数组
    if (live) return
    setCuts(addFoldCut(key, list.length))
  }, [key, live, list.length])

  // 一段已经收尾、又有新内容进来时分成几段：前面的段始终折叠，只有最后一段跟着 live 走
  const parts = fold ? splitFolds(list, cuts) : [list]
  // 运行区（子对话、子任务、后台命令、工作流运行）挂在最新一段的总结下面；
  // 结果推回来开了新的一段，就跟着挂到新的总结下面
  const lastPart = lastIndex(parts, (p) => p.length > 0)
  const body = (
    <>
      {author && <StickyAuthor author={author} />}
      {/* 回复完成后思考、工具调用和中间的说明自动收进一个折叠，折叠行写这段做了什么 */}
      {parts.map((part, i) => {
        if (!part.length) return null
        const tail = i === parts.length - 1
        // 名字只在第一段显示一次，后面几段接着上面那段接着写；
        // 按 Agent 显示的对话没有外面的署名栏，名字行自己吸顶，和按 CLI 显示的一样
        const same = { msgs: part, task, teamNames, author, command, hideAuthor: !!author || i > 0 }
        if (!fold) return <Msgs key={i} {...same} live={live} stickyAuthor={!author} />
        const isLive = !!live && tail
        const isTail = i === lastPart
        // 子对话和后台命令只在最新的一轮上列。两者都跟 latest 走：latest 已经跳过尾部刚发出的
        // 用户消息（见 latest-turn），发送的一瞬间它们不会整块消失；以前后台命令在对话停着时
        // 看 last（「最后一段」），尾部多了用户消息就会和子对话分叉，两行一起闪一下
        const kids = !!latest && isTail
        const jobs = kids
        // 运行区放在这一段的总结下面（它自己判空：没东西时连分割线也不画）。
        // 不是最新的一段也可能有没收尾的工具（子对话回报把它顶下去了），那些工具仍归它自己列；
        // 子对话、后台命令、工作流运行只在最新的一段列，旧段不重复
        const footer = (
          <RunningFooter
            task={task}
            msgs={msgs}
            live={isLive}
            tools={runningTools(part)}
            jobs={jobs}
            kids={kids}
            last={last}
            latest={latest}
            isTail={isTail}
          />
        )
        return (
          <FoldedRun
            key={i}
            {...same}
            live={isLive}
            foldId={`${key}#${i}`}
            stickyAuthor={!author && i === 0}
            running={footer}
          />
        )
      })}
      {children}
    </>
  )
  if (live) return <div className="flex flex-col gap-2">{body}</div>
  const replies = list.map(replyText).filter((x, i) => list[i].role === 'agent' && x.trim())
  return (
    <ReplyFrame text={replies.map((x) => x.trim()).join('\n\n')} at={list.at(-1)?.at} actions={actions} always={last}>
      <div className="flex flex-col gap-2">{body}</div>
    </ReplyFrame>
  )
}
