import { useState } from 'react'
import { toast } from 'sonner'
import { BellRing, FilePen, Loader2, MessageCircleQuestion, SquareTerminal, Wrench } from 'lucide-react'
import type { Task, TaskRequest } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'

const ICONS = { command: SquareTerminal, file: FilePen, tool: Wrench, question: MessageCircleQuestion }

/**
 * Agent 等你确认的操作或问题，贴在输入框上方。一次处理一个，回答后 CLI 接着执行；
 * 后面还有几个排队的在右上角标出来。
 */
export function RequestCard({ task, onAnswered }: { task: Task; onAnswered: (t: Task) => void }) {
  const { agents } = useData()
  const req = task.requests?.[0]
  const [busy, setBusy] = useState('')
  const [answer, setAnswer] = useState('')
  if (!req) return null
  const a = agents.find((x) => x.id === req.agentId)
  const Icon = ICONS[req.kind]
  const send = async (key: string, allow: boolean, text?: string) => {
    if (busy) return
    setBusy(key)
    try {
      onAnswered(await api.answerRequest(task.id, req.id, { allow, answer: text }))
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
      aria-label={req.kind === 'question' ? 'Agent 的问题' : 'Agent 请求确认'}
      className="mx-auto mb-2 max-w-[760px] overflow-hidden rounded-2xl border border-warning/50 bg-card shadow-card animate-[pop-in_160ms_ease-out]"
    >
      <div className="flex items-center gap-2 border-b border-warning/25 bg-warning/8 px-4 py-2 text-xs">
        <BellRing className="h-3.5 w-3.5 text-warning" />
        <span className="font-medium text-warning">{req.kind === 'question' ? '需要你回答' : '需要你确认'}</span>
        {a && (
          <span className="flex min-w-0 items-center gap-1.5 text-muted">
            <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
            <span className="truncate">{a.name}</span>
          </span>
        )}
        {task.requests.length > 1 && (
          <span className="ml-auto shrink-0 text-subtle">还有 {task.requests.length - 1} 个</span>
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
          <pre className="max-h-40 overflow-auto rounded-lg bg-field px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted">
            {req.detail}
          </pre>
        )}
        {req.kind === 'question' ? (
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
                placeholder={req.options.length ? '或者自己填写回答' : '填写回答'}
                aria-label="回答"
                className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-field px-3 text-[13px] outline-none focus:border-accent"
              />
              <Button size="sm" type="submit" disabled={!answer.trim() || !!busy}>
                {spin('text')}
                回答
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => send('skip', false)}>
                {spin('skip')}
                不回答
              </Button>
            </form>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => send('deny', false)}>
              {spin('deny')}
              拒绝
            </Button>
            <Button size="sm" disabled={!!busy} onClick={() => send('allow', true)}>
              {spin('allow')}
              允许
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
