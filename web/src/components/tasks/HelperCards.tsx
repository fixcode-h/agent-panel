import { memo, useEffect, useRef, useState } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import type { Task } from '@shared/schema'
import { useData } from '@/lib/data'
import { stepDuration } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { StepIcon } from './TaskStatusIcon'
import { Msgs } from './Messages'
import { t } from '@shared/i18n'

/**
 * 对话里派出的子角色：在派出的位置一行一个「子任务」，和工具调用一样收着；
 * 点开看那个子角色的实时对话流（思考、工具、回复）。父对话自己的回复不再被子角色的输出打断
 */
export function HelperCards({ task, ids, teamNames }: { task: Task; ids: string[]; teamNames: Set<string> }) {
  const running = ids.some((id) => task.steps.find((s) => s.id === id)?.status === 'running')
  const now = useNow(running)
  return (
    <div className="flex flex-col gap-1.5 pl-0 md:pl-11">
      {ids.map((id) => (
        <HelperRow key={id} task={task} id={id} now={now} teamNames={teamNames} />
      ))}
    </div>
  )
}

const HelperRow = memo(function HelperRow({
  task,
  id,
  now,
  teamNames,
}: {
  task: Task
  id: string
  now: number
  teamNames: Set<string>
}) {
  const { agents } = useData()
  const [open, setOpen] = useState(false)
  const step = task.steps.find((s) => s.id === id)
  // 这个子角色和它再派出去的子角色的消息
  const msgs = task.messages.filter((m) => m.step === id || m.step.startsWith(`${id}/`))
  const agent = agents.find((a) => a.id === step?.agentId)
  const live = step?.status === 'running'
  // 展开着、还在输出时跟着滚到最新；用户往上翻了就不再拽回来
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const size = msgs.reduce((n, m) => n + m.text.length + m.tools.length, 0)
  useEffect(() => {
    const el = box.current
    if (open && el && pinned.current) el.scrollTop = el.scrollHeight
  }, [open, size])
  if (!step) return null
  const time = stepDuration(step, now)
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-card', open && 'border-line-strong')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 px-3 text-left text-[0.8125rem] transition-colors hover:bg-sel/60"
      >
        <Bot className="h-4 w-4 shrink-0 text-subtle" />
        <span className="shrink-0 font-medium">{t('子任务')}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{step.title}</span>
        {agent && (
          <span className="hidden shrink-0 items-center gap-1.5 text-xs text-subtle sm:flex">
            <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
            {agent.name}
          </span>
        )}
        {time && <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">{time}</span>}
        <StepIcon status={step.status} />
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          className="flex max-h-[min(60vh,560px)] flex-col gap-4 overflow-y-auto border-t bg-bg/40 px-4 py-4"
        >
          {msgs.length ? (
            <Msgs msgs={msgs} task={task} teamNames={teamNames} live={live} />
          ) : (
            <p className="text-xs text-subtle">{live ? t('已开始，还没有输出') : t('没有输出')}</p>
          )}
        </div>
      )}
    </div>
  )
})
