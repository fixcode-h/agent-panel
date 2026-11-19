import { useState } from 'react'
import { Loader2, Plug } from 'lucide-react'
import type { Task, ToolUse } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { toolVerb, toolView } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { RowShell, toolPending } from './ToolRow'

/**
 * 相邻几次调同一个外部服务的同一个工具（Agent 逐个改一批资源）合成的一行：「改属性 · 第一项 等 N 次」，
 * 展开列出每一次，每次照常是一行工具行（renderRow 画，避免和 ToolRow.tsx 互相引用）。
 * 一次调用就作用到多项的批量调用本来就是一行，不走这里
 */
export function ToolGroupRow({
  tools,
  task,
  renderRow,
}: {
  tools: ToolUse[]
  task?: Pick<Task, 'status'>
  renderRow: (tool: ToolUse, key: number) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const first = toolView(tools[0])
  const pending = (x: ToolUse) => toolPending(x, task)
  const running = tools.some(pending)
  const failed = tools.filter((x) => x.failed).length
  const now = useNow(running)
  // 并行发出的几次一起跑：从最早开始的那次算到最晚结束的那次；还在跑的按现在算
  const starts = tools.map((x) => x.startedAt ?? 0).filter(Boolean)
  const ends = tools.map((x) => (x.startedAt && x.ms !== undefined ? x.startedAt + x.ms : pending(x) ? now : 0))
  const ms =
    starts.length === tools.length && ends.every(Boolean)
      ? Math.max(...ends) - Math.min(...starts)
      : running
        ? undefined
        : tools.reduce((s, x) => s + (x.ms ?? 0), 0)
  const tool = first?.tool ?? tools[0]
  const glyph = running ? (
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
  ) : (
    <Plug className={cn('h-3.5 w-3.5 shrink-0', failed === tools.length ? 'text-danger' : 'text-subtle')} />
  )
  return (
    <RowShell
      glyph={glyph}
      verb={toolVerb(tool) || tool.name}
      badge={first?.server}
      title={t('{first} 等 {n} 次', { first: tool.label, n: tools.length })}
      detail={failed ? <span className="shrink-0 text-danger">{t('{n} 次失败', { n: failed })}</span> : undefined}
      ms={ms}
      open={open}
      onToggle={() => setOpen(!open)}
      failed={failed === tools.length}
    >
      <div className="proc-list flex flex-col p-1.5">{tools.map((x, i) => renderRow(x, i))}</div>
    </RowShell>
  )
}
