import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronRight, Info } from 'lucide-react'
import type { TaskMessage } from '@shared/schema'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { ToolRow } from './ToolRow'
import { Markdown } from './Markdown'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { useAgentView } from '@/lib/agent-view'

/** 最后一个满足条件的下标（目标库没有 findLastIndex） */
function lastIndex<T>(list: T[], ok: (x: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return i
  return -1
}

export function SystemNote({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('flex items-start gap-1.5 text-xs leading-relaxed whitespace-pre-wrap text-subtle', className)}>
      <Info className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </div>
  )
}

/**
 * 思考过程：正在思考时展开并跟随最新内容，思考结束（开始输出回复）后自动收起成一行，可以点开看完整内容
 */
function Thinking({ text, live }: { text: string; live: boolean }) {
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
        <span className={cn(live && 'thinking-shimmer')}>{live ? '正在思考…' : '思考过程'}</span>
        <ChevronRight className={cn('h-3 w-3 transition-transform', shown && 'rotate-90')} />
      </button>
      {shown && (
        <div
          ref={box}
          className={cn(
            'border-l-2 border-line-strong pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]',
            live && 'max-h-40 overflow-y-auto',
          )}
        >
          {text.trim()}
        </div>
      )}
    </div>
  )
}

export type Author = { name: string; cli: string; icon?: string; model?: string }

export function AgentMessage({
  m,
  teamNames,
  compact,
  live,
  hideProcess,
  slot,
  author,
}: {
  m: TaskMessage
  teamNames: Set<string>
  compact?: boolean
  /** 这条消息正在流式输出 */
  live?: boolean
  /** 只显示回复文字，思考和工具收在外面的折叠里 */
  hideProcess?: boolean
  /** 放在名字下面、回复上面的内容（折叠起来的过程） */
  slot?: React.ReactNode
  /** 不是某个 Agent 说的（例如「AI 创建」里直接调用的 CLI）：显示这个名字和 CLI 颜色 */
  author?: Author
}) {
  const { modelOf } = useAgentView()
  const { agents } = useData()
  const a = author ? undefined : agents.find((x) => x.id === m.agentId)
  return (
    <div className="flex gap-3">
      {compact ? (
        <span className="w-[26px] shrink-0" />
      ) : a || author ? (
        <AgentAvatar icon={a?.icon ?? author!.icon ?? 'sparkles'} cli={a?.cli ?? author!.cli} size="sm" />
      ) : (
        <span className="h-[26px] w-[26px] shrink-0 rounded-[7px] bg-field" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {!compact && (
          <div className="flex items-center gap-2 pt-0.5 text-[13px]">
            <span className="font-medium">{author?.name ?? a?.name ?? '已删除的 Agent'}</span>
            {(author?.model || a) && (
              <span className="font-mono text-xs text-subtle">{author ? author.model : modelOf(a!)}</span>
            )}
          </div>
        )}
        {slot}
        {!hideProcess && m.thinking?.trim() && (
          <Thinking text={m.thinking} live={!!live && !m.text.trim() && !m.tools.length} />
        )}
        {!hideProcess && m.tools.length > 0 && (
          <div className="flex flex-col gap-1">
            {m.tools.map((t, i) => (
              <ToolRow key={i} tool={t} />
            ))}
          </div>
        )}
        {m.text && <Markdown text={m.text} teamNames={teamNames} live={live} />}
      </div>
    </div>
  )
}

/** 一串消息按顺序显示；同一个 Agent 连续的消息只显示一次头像和名字 */
export function Msgs({
  msgs,
  teamNames,
  live,
  slot,
  author,
}: {
  msgs: TaskMessage[]
  teamNames: Set<string>
  live?: boolean
  /** 放在第一条 Agent 消息名字下面的内容（展开后的折叠开关） */
  slot?: React.ReactNode
  author?: Author
}) {
  const lastAgent = lastIndex(msgs, (m) => m.role === 'agent')
  const firstAgent = msgs.findIndex((m) => m.role === 'agent')
  return (
    <>
      {msgs.map((m, k) =>
        m.role === 'system' ? (
          <SystemNote key={m.id} text={m.text} />
        ) : (
          <AgentMessage
            key={m.id}
            m={m}
            teamNames={teamNames}
            live={live && k === lastAgent}
            slot={k === firstAgent ? slot : undefined}
            author={author}
            compact={k > 0 && msgs[k - 1].role === 'agent' && msgs[k - 1].agentId === m.agentId}
          />
        ),
      )}
    </>
  )
}

/**
 * 一段完成的输出（一个节点、一轮对话）：思考、工具调用和中间的说明折叠成一行，只留最后的回复，
 * 和 Claude Code 一样；执行中的那段照常流式显示。
 */
export function FoldedRun({
  msgs,
  teamNames,
  live,
  author,
}: {
  msgs: TaskMessage[]
  teamNames: Set<string>
  live?: boolean
  author?: Author
}) {
  const [open, setOpen] = useState(false)
  const last = lastIndex(msgs, (m) => m.role === 'agent' && !!m.text.trim())
  const process = last < 0 ? [] : msgs.slice(0, last + 1).filter((m) => m.role === 'agent')
  const tools = process.reduce((n, m) => n + m.tools.length, 0)
  const thoughts = process.filter((m) => m.thinking?.trim()).length
  const notes = process.slice(0, -1).filter((m) => m.text.trim()).length
  if (live || last < 0 || (!tools && !thoughts && !notes))
    return <Msgs msgs={msgs} teamNames={teamNames} live={live} author={author} />

  const parts = [thoughts && `思考 ${thoughts} 次`, tools && `${tools} 次工具调用`, notes && `${notes} 段说明`]
  const toggle = (
    <button
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-xs text-subtle hover:text-muted"
    >
      <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
      {open ? '收起过程' : `已完成 · ${parts.filter(Boolean).join(' · ')}`}
    </button>
  )
  if (open)
    return (
      // 展开后开关仍然放在第一条回复的名字下面，不跑到名字上方
      <Msgs msgs={msgs} teamNames={teamNames} slot={toggle} author={author} />
    )
  // 折叠时：中间的系统提示照常显示，Agent 的过程收起来，最后一条回复带上名字显示
  return (
    <>
      {msgs.slice(0, last).map((m) => m.role === 'system' && <SystemNote key={m.id} text={m.text} />)}
      <AgentMessage m={msgs[last]} teamNames={teamNames} hideProcess slot={toggle} author={author} />
      <Msgs msgs={msgs.slice(last + 1)} teamNames={teamNames} author={author} />
    </>
  )
}
