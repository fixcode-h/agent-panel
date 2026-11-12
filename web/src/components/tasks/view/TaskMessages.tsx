/**
 * 对话页的消息流：把分好段的消息（task-blocks.ts）画成一轮轮回复、用户消息、运行卡片。
 * 从 TaskView.tsx 拆出来（重构文档第 13 条）：页面状态由 TaskView 管，这里只按传进来的上下文画
 */
import { Fragment } from 'react'
import { t } from '@shared/i18n'
import type { Agent, TaskMessage } from '@shared/schema'
import { deliveryActive } from '@shared/task'
import { api, type TaskPage } from '@/lib/api'
import { isAnalysisTask } from '@/lib/analysis-report'
import { UserMessage } from '@/components/chat/ChatMessage'
import type { ChatRun } from '../ChatModelPicker'
import { InlineRoutes } from '../route-context'
import { AgentMessage, DeliveryLine } from '../Messages'
import { NoteMessage } from '../SystemNote'
import { ReceivedRow } from '../PeerMessage'
import { RunCard } from '../RunCard'
import { RegenerateButton } from '../RewindDialog'
import { StepSection } from '../StepSection'
import { UserMessageMenu } from '../UserMessageMenu'
import { ChatTurn, RunChecklist } from '../TaskViewParts'
import type { Block } from '../task-blocks'

export interface TaskMessagesCtx {
  task: TaskPage
  /** 已经画出来的那几段（前面 hidden 段先不画），和全部段数 */
  shown: Block[]
  hidden: number
  total: number
  /** 最新的一轮在全部段里的下标（见 lib/latest-turn.ts） */
  latestTurn: number
  working: boolean
  running: boolean
  teamNames: Set<string>
  /** 不用角色的对话：署名按 CLI、模型显示 */
  fallback?: ChatRun
  /** 对话里第一条用户消息（分析对话把它画成「分析对象」卡片） */
  firstUser?: string
  localAgents: Agent[]
  /** 有项目才能「记成项目教训」 */
  hasProject: boolean
  workflowName?: string
  apply: (t: TaskPage) => void
  stickToBottom: () => void
  resend: (m: TaskMessage) => Promise<void>
  fork: (messageId: string) => Promise<void>
  onRewind: (messageId: string) => void
  onLesson: (text: string) => void
  openRun: (run: number) => void
  openFlow: (id?: string) => void
}

export function TaskMessages({ ctx }: { ctx: TaskMessagesCtx }) {
  const { shown } = ctx
  // 一轮回复和后面的用户消息放同一个容器：吸顶署名的粘性包含块是它，会一直保持到下一段回复头
  const out: React.ReactNode[] = []
  for (let i = 0; i < shown.length; i++) {
    const b = shown[i]
    if (b.kind !== 'turn') {
      out.push(renderBlock(ctx, b, i))
      continue
    }
    let end = i + 1
    while (end < shown.length && shown[end].kind === 'msg') end++
    out.push(
      <div key={b.key} className="flex flex-col gap-2">
        {renderBlock(ctx, b, i)}
        {shown.slice(i + 1, end).map((m, j) => (
          <div key={m.kind === 'msg' ? m.m.id : `follow-${i}-${j}`} className="mt-3">
            {renderBlock(ctx, m, i + 1 + j)}
          </div>
        ))}
      </div>,
    )
    i = end - 1
  }
  return <>{out}</>
}

function renderBlock(ctx: TaskMessagesCtx, b: Block, i: number): React.ReactNode {
  const { task, hidden, total, working, apply } = ctx
  if (b.kind === 'turn')
    return (
      <ChatTurn
        key={b.key}
        msgs={b.msgs}
        task={task}
        teamNames={ctx.teamNames}
        live={working && i + hidden === total - 1}
        last={!working && i + hidden === total - 1}
        // 最新的一轮：和 last 分开，子对话列表按它列（父对话自己还在跑时也要列，
        // 刚发出的用户消息排在后面时也算）
        latest={i + hidden === ctx.latestTurn}
        fallback={ctx.fallback}
        command={task.command}
        actions={
          // 最后一条回复下面：重新生成（撤回最后一条消息和这一轮改的文件，再原样发一次）
          task.mode === 'chat' && !task.imported && !working && i + hidden === total - 1 ? (
            <RegenerateButton
              task={task}
              onRewound={apply}
              send={async (text, att) => {
                ctx.stickToBottom()
                apply(await api.sendMessage(task.id, text, att, false))
              }}
            />
          ) : undefined
        }
      />
    )
  if (b.kind === 'run')
    return task.mode === 'chat' && (task.runs?.length ?? 0) > 0 ? (
      // 和 AI 回复的正文对齐（缩进同 .reply-body）：对话里的工作流卡片、收发消息都在同一条竖线上
      <div key={b.key} className="reply-indent min-w-0">
        <RunChecklist task={task} run={b.run} onOpen={() => ctx.openRun(b.run)} />
      </div>
    ) : (
      <div key={b.key} className="reply-indent min-w-0">
        <RunCard
          task={task}
          run={b.run}
          name={task.workflowName || ctx.workflowName}
          onOpen={() => (task.mode === 'workflow' ? ctx.openFlow() : ctx.openRun(b.run))}
          onStep={task.mode === 'workflow' ? ctx.openFlow : undefined}
        />
      </div>
    )
  if (b.kind === 'steps')
    return (
      <div key={b.key} className="flex flex-col gap-7">
        {b.roots.map((r) => (
          <StepSection key={r} task={task} rootId={r} msgs={b.byRoot.get(r)!} teamNames={ctx.teamNames} sticky="chat" />
        ))}
      </div>
    )
  if (b.m.peer)
    return (
      <div key={b.m.id} className="reply-indent min-w-0">
        <ReceivedRow m={b.m} />
      </div>
    )
  if (b.m.role === 'user') {
    const m = b.m
    return (
      <Fragment key={m.id}>
        <UserMessage
          anchorId={m.id}
          // 分析对话的第一句是面板拼好的报错 / 记录：画成「分析对象」卡片（设计稿 AiWindow）。
          // 不只在 AI 分析窗口里：从窗口「在父对话里打开」放大到对话页后也一样折叠成卡片，不铺成整段长文
          subject={
            m.id === ctx.firstUser && isAnalysisTask(task, ctx.localAgents)
              ? { label: t('分析对象'), hint: t('面板自动附上') }
              : undefined
          }
          text={m.text}
          at={m.at}
          attachments={m.attachments}
          status={
            m.delivery && (
              <DeliveryLine
                delivery={m.delivery}
                active={deliveryActive(m.delivery.at, task)}
                onResend={task.imported ? undefined : () => void ctx.resend(m)}
              />
            )
          }
          actions={
            <UserMessageMenu
              chat={task.mode === 'chat' && !task.imported}
              // 第一条也能撤：等于清空对话重新开始（服务端从头开会话）
              canRewind
              canLesson={ctx.hasProject && !task.imported}
              running={ctx.running}
              onRewind={() => ctx.onRewind(m.id)}
              onFork={() => ctx.fork(m.id)}
              onLesson={() => ctx.onLesson(m.text)}
            />
          }
        />
        {/* 分诊卡插在 AI 回复里发起它的位置；对不上回复的旧数据才留在用户消息下面 */}
        <InlineRoutes msgId={m.id} inline={false} />
      </Fragment>
    )
  }
  // 报错、警告卡片挂在回复体外面：缩进到和回复正文对齐，不比正文往左多伸出一截
  if (b.m.role === 'system')
    return <NoteMessage key={b.m.id} m={b.m} task={task} className="justify-center text-center" indent />
  return <AgentMessage key={b.m.id} m={b.m} task={task} teamNames={ctx.teamNames} />
}
