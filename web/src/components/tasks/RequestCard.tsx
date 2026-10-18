import { useState } from 'react'
import { toast } from 'sonner'
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
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { t } from '@shared/i18n'

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
  className,
}: {
  requests: TaskRequest[]
  onAnswer: (id: string, r: { allow: boolean; answer?: string }) => Promise<void>
  agent?: { name: string; icon: string; cli: string }
  className?: string
}) {
  const req = requests[0]
  const [busy, setBusy] = useState('')
  const [answer, setAnswer] = useState('')
  if (!req) return null
  const a = agent
  const Icon = ICONS[req.kind]
  const send = async (key: string, allow: boolean, text?: string) => {
    if (busy) return
    setBusy(key)
    try {
      await onAnswer(req.id, { allow, answer: text })
      setAnswer('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const spin = (key: string) => busy === key && <Loader2 className="h-3.5 w-3.5 animate-spin" />

  return (
    <div
      role="alertdialog"
      aria-label={req.kind === 'question' ? t('Agent 的问题') : t('Agent 请求确认')}
      className={cn(
        'mx-auto mb-2 max-w-(--content-w) overflow-hidden rounded-2xl border border-warning/50 bg-card shadow-card animate-[pop-in_160ms_ease-out]',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-warning/25 bg-warning/8 px-4 py-2 text-xs">
        <CircleAlert className="h-3.5 w-3.5 text-warning" />
        <span className="font-medium text-warning">{req.kind === 'question' ? t('需要你回答') : t('需要你确认')}</span>
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
              'min-w-0 text-[13.5px] leading-relaxed [overflow-wrap:anywhere]',
              req.kind === 'command' && 'font-mono text-[13px]',
            )}
          >
            {req.title}
          </span>
        </div>
        {req.detail && (
          <pre
            className={cn(
              'overflow-auto rounded-lg bg-field px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted',
              req.kind === 'confirm' ? 'max-h-72' : 'max-h-40',
            )}
          >
            {req.detail}
          </pre>
        )}
        {req.kind === 'confirm' ? (
          // 工作流节点完成后等你确认：通过就往下走，退回时写上要改的地方，节点按意见继续完善
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void send('allow', true)
            }}
          >
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={2}
              placeholder={t('要退回修改时，写上要改的地方')}
              aria-label={t('退回意见')}
              className="min-w-0 resize-none rounded-lg border border-line-strong bg-field px-3 py-2 text-[13px] outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!!busy || !answer.trim()}
                title={answer.trim() ? undefined : t('先写上要改的地方')}
                onClick={() => send('deny', false, answer.trim())}
              >
                {spin('deny')}
                {t('退回修改')}
              </Button>
              <Button size="sm" type="submit" disabled={!!busy}>
                {spin('allow')}
                {t('通过，继续')}
              </Button>
            </div>
          </form>
        ) : req.kind === 'question' ? (
          <div className="flex flex-col gap-2">
            {req.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {req.options.map((o) => (
                  <Button key={o} size="sm" variant="secondary" disabled={!!busy} onClick={() => send(o, true, o)}>
                    {spin(o)}
                    {o}
                  </Button>
                ))}
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (answer.trim()) void send('text', true, answer.trim())
              }}
            >
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={req.options.length ? t('或者自己填写回答') : t('填写回答')}
                aria-label={t('回答')}
                className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-field px-3 text-[13px] outline-none focus:border-accent"
              />
              <Button size="sm" type="submit" disabled={!answer.trim() || !!busy}>
                {spin('text')}
                {t('回答')}
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => send('skip', false)}>
                {spin('skip')}
                {t('不回答')}
              </Button>
            </form>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  )
}
