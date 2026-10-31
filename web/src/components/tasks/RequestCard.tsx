import { useState } from 'react'
import { toast } from '@/lib/toast'
import {
  CircleAlert,
  ClipboardCheck,
  FilePen,
  Loader2,
  MessageCircleQuestion,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import type { Task, TaskRequest } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ReviewDialog } from './ReviewDialog'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { QuestionPanel, type PanelQuestion } from '@/components/chat/QuestionPanel'
import { t } from '@shared/i18n'

/** 请求里的问题：一次问了几个时每个一条，旧的请求只有标题和选项 */
export const requestQuestions = (req: TaskRequest): PanelQuestion[] =>
  req.questions?.length
    ? req.questions
    : [{ question: req.title, header: req.detail, options: req.options.map((label) => ({ label })) }]

/** 第一个等你处理的是问题：问题面板换掉输入框 */
export const asksQuestion = (requests: TaskRequest[] | undefined) => requests?.[0]?.kind === 'question'

const ICONS = {
  command: SquareTerminal,
  file: FilePen,
  tool: Wrench,
  question: MessageCircleQuestion,
  confirm: ClipboardCheck,
}

/** 任务页：请求存在任务里，回答后换成新的任务 */
export function TaskRequestCard({ task, onAnswered }: { task: Task; onAnswered: (t: Task) => void }) {
  const { agents } = useData()
  const req = task.requests?.[0]
  const a = req && agents.find((x) => x.id === req.agentId)
  return (
    <RequestCard
      requests={task.requests ?? []}
      agent={a ? { name: a.name, icon: a.icon, cli: a.cli } : undefined}
      onAnswer={async (id, r) => onAnswered(await api.answerRequest(task.id, id, r))}
      // 关掉提问：这个问题不回答，终止对话；之后发消息或继续执行时 AI 再接着做
      onClose={async () => onAnswered(await api.stopTask(task.id))}
    />
  )
}

/**
 * AI 等你确认的操作或问题，贴在输入框上方。一次处理一个，回答后 CLI 接着执行；
 * 后面还有几个排队的在右上角标出来。任务页和其他 AI 会话（UI 设计、AI 创建…）共用
 */
export function RequestCard({
  requests,
  onAnswer,
  agent,
  onClose,
  className,
}: {
  requests: TaskRequest[]
  onAnswer: (id: string, r: { allow: boolean; answer?: string; answers?: string[] }) => Promise<void>
  agent?: { name: string; icon: string; cli: string }
  /** 提问右上角的关闭（不回答，终止对话）；不给就没有关闭按钮 */
  onClose?: () => Promise<void>
  className?: string
}) {
  const req = requests[0]
  const [busy, setBusy] = useState('')
  if (!req) return null
  const a = agent
  const Icon = ICONS[req.kind]
  const send = async (key: string, allow: boolean, text?: string) => {
    if (busy) return
    setBusy(key)
    try {
      await onAnswer(req.id, { allow, answer: text })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const spin = (key: string) => busy === key && <Loader2 className="h-3.5 w-3.5 animate-spin" />

  // 问题：换掉输入框显示，一次问了几个时全部回答完一起交回去
  if (req.kind === 'question')
    return (
      <QuestionPanel
        className={className}
        questions={requestQuestions(req)}
        who={
          a && (
            <>
              <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
              <span className="truncate">{a.name}</span>
            </>
          )
        }
        onSubmit={async (answers) => {
          try {
            await onAnswer(req.id, { allow: true, answer: answers.join('\n'), answers })
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
        onSkip={async () => {
          try {
            await onAnswer(req.id, { allow: false })
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
        skipLabel={t('不回答，让 AI 自己决定')}
        onClose={
          onClose &&
          (async () => {
            try {
              await onClose()
            } catch (e) {
              toast.error((e as Error).message)
            }
          })
        }
      />
    )

  // 工作流节点完成后等你确认：输入框上方只留一条入口，点开审阅弹窗看结果、做标注，再决定修改还是确认
  if (req.kind === 'confirm')
    return (
      <ConfirmEntry
        req={req}
        agent={a}
        more={requests.length - 1}
        answer={(allow, text) => onAnswer(req.id, { allow, answer: text })}
        className={className}
      />
    )

  return (
    <div
      role="alertdialog"
      aria-label={t('Agent 请求确认')}
      className={cn(
        'mx-auto mb-2 max-w-(--content-w) overflow-hidden rounded-2xl border border-warning/50 bg-card shadow-card animate-[pop-in_160ms_ease-out]',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-warning/25 bg-warning/8 px-4 py-2 text-xs">
        <CircleAlert className="h-3.5 w-3.5 text-warning" />
        <span className="font-medium text-warning">{t('需要你确认')}</span>
        {a && (
          <span className="flex min-w-0 items-center gap-1.5 text-muted">
            <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
            <span className="truncate">{a.name}</span>
          </span>
        )}
        {requests.length > 1 && (
          <span className="ml-auto shrink-0 text-subtle">{t('还有 {n} 个', { n: requests.length - 1 })}</span>
        )}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span
            className={cn(
              'min-w-0 text-body leading-relaxed [overflow-wrap:anywhere]',
              req.kind === 'command' && 'font-mono text-body',
            )}
          >
            {req.title}
          </span>
        </div>
        {req.detail && (
          <pre className="max-h-40 overflow-auto rounded-lg bg-field px-3 py-2 font-mono text-footnote leading-relaxed whitespace-pre-wrap text-muted">
            {req.detail}
          </pre>
        )}
        {
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => send('deny', false)}>
              {spin('deny')}
              {t('拒绝')}
            </Button>
            <Button size="sm" disabled={!!busy} onClick={() => send('allow', true)}>
              {spin('allow')}
              {t('允许')}
            </Button>
          </div>
        }
      </div>
    </div>
  )
}

/**
 * 节点完成后等你确认的入口：只这一种请求换成弹窗审阅（其他确认、提问照旧）。
 * 结果在弹窗里按 Markdown 渲染，可以选中标注；修改把标注交回 Agent 返工，确认就往下走
 */
function ConfirmEntry({
  req,
  agent,
  more,
  answer,
  className,
}: {
  req: TaskRequest
  agent?: { name: string; icon: string; cli: string }
  more: number
  /** 出错时抛出：弹窗留着、提示错误，标注不会白写 */
  answer: (allow: boolean, text?: string) => Promise<void>
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div
        role="alertdialog"
        aria-label={t('Agent 请求确认')}
        className={cn(
          'mx-auto mb-2 flex max-w-(--content-w) items-center gap-2.5 rounded-2xl border border-warning/50 bg-card px-4 py-2.5 shadow-card animate-[pop-in_160ms_ease-out]',
          className,
        )}
      >
        <ClipboardCheck className="h-4 w-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium">{req.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="shrink-0 text-warning">{t('需要你确认')}</span>
            {agent && (
              <>
                <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
                <span className="truncate">{agent.name}</span>
              </>
            )}
            {more > 0 && <span className="shrink-0 text-subtle">· {t('还有 {n} 个', { n: more })}</span>}
          </span>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          {t('查看结果')}
        </Button>
      </div>
      <ReviewDialog req={req} agent={agent} open={open} onOpenChange={setOpen} onAnswer={answer} />
    </>
  )
}
