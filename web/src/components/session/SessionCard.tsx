import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 每块收没收起记在本机：换对话、刷新后还是用户上次的样子 */
const FOLD_KEY = 'session-bar:folded'

function readFolded(id: string) {
  try {
    return (JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]).includes(id)
  } catch {
    return false
  }
}

function writeFolded(id: string, folded: boolean) {
  try {
    const list = (JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]).filter((x) => x !== id)
    localStorage.setItem(FOLD_KEY, JSON.stringify(folded ? [...list, id] : list))
  } catch {}
}

/**
 * 会话栏的一块（照 Claude Code 的会话栏）：细描边的圆角卡片，标题后面跟一个小箭头，点标题收起展开。
 * id 用来记住收起状态；trailing 放在标题行右端（数量、操作按钮）
 */
export function SessionCard({
  id,
  title,
  trailing,
  children,
  className,
}: {
  id: string
  title: string
  trailing?: ReactNode
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(() => !readFolded(id))
  return (
    <section
      aria-label={title}
      data-session-card={id}
      className={cn('rounded-xl border border-line bg-bg px-3.5 py-3', className)}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
            writeFolded(id, open)
          }}
          className="-mx-1 flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[0.8125rem] font-medium text-fg hover:bg-sel"
        >
          {title}
          <ChevronDown className={cn('h-3.5 w-3.5 text-subtle transition-transform', !open && '-rotate-90')} />
        </button>
        {trailing && <div className="ml-auto flex shrink-0 items-center gap-1">{trailing}</div>}
      </div>
      {open && <div className="mt-2.5 flex flex-col">{children}</div>}
    </section>
  )
}

/**
 * 会话栏里的一行：左边图标，中间文字（放不下截断，悬停看全文），右边可选的操作。
 * 给了 onClick 整行就是按钮
 */
export function SessionRow({
  icon,
  children,
  title,
  trailing,
  onClick,
  className,
}: {
  icon: ReactNode
  children: ReactNode
  title?: string
  trailing?: ReactNode
  onClick?: () => void
  className?: string
}) {
  const body = (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left" title={title}>
        {children}
      </span>
    </>
  )
  const cls = cn('flex min-h-8 items-center gap-2.5 rounded-md px-1 text-[0.8125rem] text-fg', className)
  return (
    <div className="-mx-1 flex items-center gap-1">
      {onClick ? (
        <button type="button" onClick={onClick} className={cn(cls, 'min-w-0 flex-1 cursor-pointer hover:bg-sel')}>
          {body}
        </button>
      ) : (
        <div className={cn(cls, 'min-w-0 flex-1')}>{body}</div>
      )}
      {trailing}
    </div>
  )
}

/**
 * 可展开的一组（「> MCP 工具  38」）：收起时只有标题和数量，展开后列出各项。
 * 列表长时在块里滚动，不把下面的卡片挤到很远
 */
export function SessionDisclosure({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        disabled={!count}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex h-7 items-center gap-1.5 rounded-md px-1 text-[0.8125rem] text-muted enabled:cursor-pointer enabled:hover:bg-sel enabled:hover:text-fg"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <span className="font-mono text-xs text-subtle tabular-nums">{count}</span>
      </button>
      {open && (
        <ul className="ml-5 flex max-h-56 flex-col overflow-y-auto overscroll-contain border-l border-line py-0.5 pl-2.5">
          {children}
        </ul>
      )}
    </div>
  )
}

/** 展开后的一项：名字和右边的数（token） */
export function SessionDisclosureItem({ name, value, title }: { name: string; value: string; title?: string }) {
  return (
    <li className="flex h-6 items-center gap-2 text-xs" title={title ?? name}>
      <span className="min-w-0 flex-1 truncate font-mono text-muted">{name}</span>
      <span className="shrink-0 font-mono text-subtle tabular-nums">{value}</span>
    </li>
  )
}
