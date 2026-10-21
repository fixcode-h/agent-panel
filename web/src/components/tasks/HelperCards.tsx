import { memo, useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { ChevronRight, X } from 'lucide-react'
import type { Task } from '@shared/schema'
import { useData } from '@/lib/data'
import { stepDuration } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { StepIcon } from './TaskStatusIcon'
import { Msgs } from './Messages'
import { t } from '@shared/i18n'

/**
 * 对话里派出的子任务：在派出的位置一行一个，和工具调用一样排在 AI 的回复里；
 * 转圈是执行中，绿勾是完成，红叉是失败。点开是一个只读的子任务窗口：看它的实时对话流，没有输入框，
 * 做完 CLI 就退出了，再打开也只是查看，不会重新启动
 */
export function HelperCards({ task, ids, teamNames }: { task: Task; ids: string[]; teamNames: Set<string> }) {
  const running = ids.some((id) => task.steps.find((s) => s.id === id)?.status === 'running')
  const now = useNow(running)
  return (
    <div className="flex flex-col gap-1">
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
  // 默认的「子任务」角色不用再写一遍名字；点名派给「测试验收」这类角色时才标出来
  const agent = agents.find((a) => a.id === step?.agentId && a.origin !== 'builtin:helper')
  if (!step) return null
  const time = stepDuration(step, now)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('打开子任务')}
        className={cn(
          'group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border bg-field px-2.5 py-1.5 text-left font-mono text-xs text-muted transition-colors hover:text-fg',
          step.status === 'failed' && 'border-danger/30',
        )}
      >
        <StepIcon status={step.status} className="h-3.5 w-3.5" />
        <span className="shrink-0 font-sans font-medium text-fg/80">{t('子任务')}</span>
        <span className="min-w-0 flex-1 truncate">{step.title}</span>
        {agent && (
          <span className="hidden shrink-0 items-center gap-1.5 font-sans text-subtle sm:flex">
            <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
            {agent.name}
          </span>
        )}
        {time && <span className="shrink-0 font-mono text-subtle tabular-nums">{time}</span>}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition group-hover:opacity-100" />
      </button>
      {open && <HelperWindow task={task} id={id} teamNames={teamNames} onClose={() => setOpen(false)} />}
    </>
  )
})

/** 子任务窗口：只读的对话流，跟着父对话的推送实时更新；没有输入框 */
function HelperWindow({
  task,
  id,
  teamNames,
  onClose,
}: {
  task: Task
  id: string
  teamNames: Set<string>
  onClose: () => void
}) {
  const { agents } = useData()
  const step = task.steps.find((s) => s.id === id)
  const live = step?.status === 'running'
  const now = useNow(live)
  // 这个子任务自己的消息（旧数据里它再派出去的也在它名下）
  const msgs = task.messages.filter((m) => m.step === id || m.step.startsWith(`${id}/`))
  const agent = agents.find((a) => a.id === step?.agentId && a.origin !== 'builtin:helper')
  // 还在输出时跟着滚到最新；用户往上翻了就不再拽回来
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const size = msgs.reduce((n, m) => n + m.text.length + m.tools.length + (m.thinking?.length ?? 0), 0)
  useEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [size])
  if (!step) return null
  const time = stepDuration(step, now)
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(820px,calc(100dvh-2rem))] w-[min(880px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-bg shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-4">
            <StepIcon status={step.status} />
            <span className="shrink-0 text-[0.8125rem] text-muted">{t('子任务')}</span>
            <D.Title className="min-w-0 flex-1 truncate text-[0.84375rem] font-medium" title={step.title}>
              {step.title}
            </D.Title>
            {agent && (
              <span className="hidden shrink-0 items-center gap-1.5 text-xs text-subtle sm:flex">
                <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
                {agent.name}
              </span>
            )}
            {time && <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">{time}</span>}
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div
            ref={box}
            onScroll={(e) => {
              const el = e.currentTarget
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto flex max-w-(--content-w) flex-col gap-4 px-4 py-5 md:px-6">
              {msgs.length ? (
                <Msgs msgs={msgs} task={task} teamNames={teamNames} live={live} />
              ) : (
                <p className="text-xs text-subtle">{live ? t('已开始，还没有输出') : t('没有输出')}</p>
              )}
            </div>
          </div>
          {/* 子任务没有输入框：做完 CLI 已经退出，这里只能查看 */}
          <footer className="shrink-0 border-t bg-card px-4 py-2.5 text-xs text-subtle">
            {live
              ? t('子任务执行中，做完后结果会自动交回给派它的对话')
              : step.status === 'pending'
                ? t('子任务在排队，前面的做完就开始')
                : step.status === 'failed'
                  ? t('子任务失败了，派它的对话会收到失败原因。这里只能查看')
                  : t('子任务已结束，结果已交回给派它的对话。这里只能查看')}
          </footer>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
