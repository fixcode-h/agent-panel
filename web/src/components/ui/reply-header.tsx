import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * AI 回复的开头：角色图标（圆角方块）+ 角色名，后面灰色等宽字写「Agent（默认）  强度 · 渠道/模型」。
 * 图标、颜色由调用方给（AgentAvatar 那套），这里只管排版，各处回复开头都用它
 */
export function ReplyHeader({
  avatar,
  name,
  agent,
  effort,
  model,
  trailing,
  className,
}: {
  avatar: ReactNode
  name: ReactNode
  agent?: ReactNode
  effort?: ReactNode
  model?: ReactNode
  /** 行尾的操作（复制、折叠全部） */
  trailing?: ReactNode
  className?: string
}) {
  const meta = [agent, effort].filter(Boolean)
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span className="shrink-0">{avatar}</span>
      <span className="shrink-0 text-[0.875rem] font-semibold">{name}</span>
      {(meta.length > 0 || model) && (
        <span className="min-w-0 truncate font-mono text-[0.75rem] text-subtle">
          ·{' '}
          {meta.map((m, i) =>
            i ? (
              <span key={i}>
                {'　'}
                {m}
              </span>
            ) : (
              <span key={i}>{m}</span>
            ),
          )}
          {model && <> · {model}</>}
        </span>
      )}
      {trailing && <span className="ml-auto flex shrink-0 items-center gap-1">{trailing}</span>}
    </div>
  )
}
