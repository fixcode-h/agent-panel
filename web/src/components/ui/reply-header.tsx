import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * AI 回复的开头（设计稿回复头）：彩色角色图标（不带底色块）+ 角色名，后面次要色写「· Agent · 模型 · 强度」。
 * 图标（22px 宽）加间距正好 32px，名字和缩进的正文、复制按钮对齐。图标由调用方给，这里只管排版，各处回复开头都用它；窄的时候先压缩后面这段，名字不被截断
 */
export function ReplyHeader({
  avatar,
  name,
  agent,
  effort,
  model,
  title,
  trailing,
  className,
}: {
  avatar: ReactNode
  name: ReactNode
  agent?: ReactNode
  effort?: ReactNode
  model?: ReactNode
  /** 悬停整行时的提示（例如省掉没写的 CLI 名） */
  title?: string
  /** 行尾的操作（复制、折叠全部） */
  trailing?: ReactNode
  className?: string
}) {
  const meta = [agent, model, effort].filter(Boolean)
  return (
    // data-reply-head：放在缩进的回复（.reply-body）里时，回复头退回最左边，见 index.css
    <div data-reply-head="row" title={title} className={cn('flex h-7 min-w-0 items-center gap-2.5', className)}>
      <span className="flex shrink-0 items-center">{avatar}</span>
      <span className="shrink-0 text-heading font-semibold whitespace-nowrap">{name}</span>
      {meta.length > 0 && (
        <span className="min-w-0 truncate text-body whitespace-nowrap text-subtle">
          {meta.map((m, i) => (
            <span key={i}>· {m} </span>
          ))}
        </span>
      )}
      {trailing && <span className="ml-auto flex shrink-0 items-center gap-1">{trailing}</span>}
    </div>
  )
}
