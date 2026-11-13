import type { ReactNode } from 'react'
import { MessageSquareQuote } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ChatQuoteItem {
  id: string
  /** 消息的时间（ISO）：按本地时间显示到分钟 */
  at: string
  text: string
}

/** 本地时间的「时:分」：同一段对话里的几句，看时间先后就够了 */
const clock = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 原话引用卡（诊断报告「依据你在对话里说的」，设计稿「诊断报告-跟随子对话聊天更新」）：
 * 一组用户在对话里说过的话，每句前面是时间，原样摆出来（不是 Agent 的转述）。
 * onJump 给了就能点一句跳回对话里那条消息；aside 放在标题右边（状态胶囊），footer 放在最下面（操作按钮）
 */
export function ChatQuotes({
  title,
  items,
  aside,
  footer,
  onJump,
  className,
}: {
  title: ReactNode
  items: ChatQuoteItem[]
  aside?: ReactNode
  footer?: ReactNode
  onJump?: (id: string) => void
  className?: string
}) {
  return (
    <div data-chat-quotes className={cn('rounded-lg border border-line bg-card px-3 py-2', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MessageSquareQuote className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 text-footnote text-muted">{title}</span>
        {aside}
      </div>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {items.map((x) => {
          const body = (
            <>
              <span className="w-10 shrink-0 pt-px font-mono text-caption text-subtle">{clock(x.at)}</span>
              <span className="line-clamp-3 min-w-0 flex-1 text-body whitespace-pre-wrap text-fg">{x.text}</span>
            </>
          )
          return (
            <li key={x.id}>
              {onJump ? (
                <button
                  type="button"
                  onClick={() => onJump(x.id)}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-2 py-1">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {footer && <div className="mt-2 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
    </div>
  )
}
