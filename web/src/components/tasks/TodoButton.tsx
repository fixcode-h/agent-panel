import { useEffect, useRef, useState } from 'react'
import { ListTodo } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { useEscape } from '@/lib/useEscape'
import { cn } from '@/lib/utils'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { Progress } from '@/components/ui/progress'
import { StepIcon } from './TaskStatusIcon'

/**
 * Chat 模式的计划：CLI 自带的待办 / 计划（Claude Code 的 TodoWrite、Codex 的 plan，解析成 task.todos）。
 * 面板计划只在 Agent 模式（ADR 0038），Chat 页用 CLI 自己的：和面板计划同一个位置、同一种折叠行，点开看全部步骤
 */
export function TodoButton({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscape(open, () => setOpen(false))
  // 点外面关：和计划窗口一样
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const todos = task.todos ?? []
  if (!todos.length) return null
  const done = todos.filter((x) => x.status === 'done').length
  const current = todos.find((x) => x.status === 'running')?.text
  const finished = done === todos.length
  return (
    <div ref={ref} className="relative flex min-w-0 shrink items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('待办')}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-body text-muted transition-colors hover:bg-sel hover:text-fg',
          open && 'bg-sel text-fg',
        )}
      >
        <ListTodo className={cn('h-3.5 w-3.5 shrink-0', finished ? 'text-success' : 'text-subtle')} />
        <span className="shrink-0 font-medium">
          {finished ? t('待办已完成') : t('待办 {done}/{total}', { done, total: todos.length })}
        </span>
        {!finished && (
          <Progress
            value={done}
            max={todos.length}
            raw
            label={t('待办进度 {done}/{total}', { done, total: todos.length })}
            className="w-10 shrink-0 sm:w-14"
          />
        )}
        {!finished && current && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-subtle">
            <span>·</span>
            <span className="min-w-0 truncate">{current}</span>
          </span>
        )}
      </button>
      {open && (
        <ComposerPopover role="dialog" aria-label={t('待办')} className="max-h-[min(64vh,560px)]">
          <div className="flex shrink-0 items-center gap-2 border-b px-4 pt-3.5 pb-3">
            <ListTodo className="h-4 w-4 shrink-0 text-muted" />
            <span className="text-body font-medium">{t('待办')}</span>
            <span className="text-xs text-subtle tabular-nums">
              {done}/{todos.length}
            </span>
            <span className="ml-auto text-caption text-subtle">{t('由 Agent 自己列出')}</span>
          </div>
          <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto px-4 py-3">
            {todos.map((td, i) => (
              <li key={i} className="flex items-start gap-2 text-body">
                <StepIcon status={td.status} className="mt-0.5 h-3.5 w-3.5" />
                <span
                  className={cn(
                    'min-w-0 flex-1 [overflow-wrap:anywhere]',
                    // 完成的只调灰、不加删除线（和计划面板一致）
                    td.status === 'done' ? 'text-subtle' : 'text-fg',
                    td.status === 'running' && 'font-medium',
                  )}
                >
                  {td.text}
                </span>
              </li>
            ))}
          </ul>
        </ComposerPopover>
      )}
    </div>
  )
}
