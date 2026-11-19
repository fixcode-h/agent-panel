/**
 * 消息流末尾的一行进行中状态：Chat 对话「正在回复 / 思考中」、这一轮说完后在等什么、工作流主角色在处理。
 * 从 TaskView.tsx 拆出来（复查报告 B2）：在不在跑、等什么都由页面算好传进来，这里只按它画
 */
import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { ChildWait } from '@shared/task'
import type { TaskPage } from '@/lib/api'
import type { ChatRun } from '../ChatModelPicker'
import { LiveStats } from '../LiveStats'
import { ChatWaitLine, PendingReply, RunPhase } from '../TaskViewParts'

export function ReplyStatus({
  task,
  running,
  working,
  lastIsTurn,
  chatLabel,
  fallback,
  chatWait,
  awaiting,
  noRunningSteps,
  mainName,
  onStatus,
}: {
  task: TaskPage
  running: boolean
  working: boolean
  /** 最后一段已经是 AI 的一轮回复（有输出了） */
  lastIsTurn: boolean
  chatLabel: string
  /** 不用角色的对话按 CLI 显示署名 */
  fallback?: ChatRun
  chatWait?: ChildWait
  /** CLI 真的停在面板工具上等下一句 */
  awaiting: boolean
  /** 工作流里没有正在跑的步骤 */
  noRunningSteps: boolean
  mainName?: string
  onStatus: () => void
}) {
  return (
    <>
      {running &&
        task.mode !== 'workflow' &&
        working &&
        (lastIsTurn ? (
          <div className="flex items-center gap-2 text-body text-muted">
            <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
            <RunPhase
              task={task}
              label={t('{name} 正在回复', { name: chatLabel })}
              agentIds={[task.agentId]}
              onStatus={onStatus}
            />
            <LiveStats task={task} agentIds={[task.agentId]} />
          </div>
        ) : (
          // 发出消息、还没有输出时就显示是谁在回复、用的哪个模型，不用等第一段输出
          <PendingReply fallback={fallback} agentId={task.agentId}>
            <div className="flex items-center gap-2 text-body text-muted">
              <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
              <RunPhase task={task} label={t('思考中…')} agentIds={[task.agentId]} onStatus={onStatus} />
              <LiveStats task={task} agentIds={[task.agentId]} />
            </div>
          </PendingReply>
        ))}
      {/* 这一轮没在跑时先说清在等什么：等后台命令、等派出的子任务、等工作流，最后才是真的停在等下一句。
      以前只看 awaitingUser 就写「等待你的下一条消息」，子任务还在跑时也这么说
      （用户报的：子任务在跑、状态行却说在等你 + 空闲）。判定统一用 childWait，不另写一套 */}
      {running && task.mode !== 'workflow' && !working && chatWait && (
        <ChatWaitLine wait={chatWait} awaiting={awaiting} task={task} onStatus={onStatus} />
      )}
      {working && task.mode === 'workflow' && noRunningSteps && (
        <div className="flex items-center gap-2 text-body text-muted">
          <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
          <RunPhase task={task} label={t('{name} 正在处理', { name: mainName ?? t('主角色') })} />
          <LiveStats task={task} />
        </div>
      )}
    </>
  )
}
