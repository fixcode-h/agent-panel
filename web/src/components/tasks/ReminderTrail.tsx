import { useState, type HTMLAttributes } from 'react'
import { BellRing, ChevronRight, CircleCheck, TriangleAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TrailItem } from '@shared/end-turn'
import { cn } from '@/lib/utils'
import { LEAD_TAG } from './panel-kind'
import { localStamp } from './life-log-rows'

/**
 * 状态诊断日志里的「面板提醒」行：面板的提醒（结束前钩子拦住、一轮结束后补发）和 Agent 用 end_turn 交代的结束。
 * 以前单独一张卡片列在日志上面，用户 2026-11-05 要求按时间插进日志里（life-log-rows.ts 的 buildRows 负责插）。
 * 提醒和 end_turn 都不画进对话（用户 2026-11-05 定），这里是唯一能看到它们的地方。
 * 每行的结果按结构算（提醒之后调了几次工具、end_turn 的 outcome），不看回复文字
 */
export function TrailLine({
  item: x,
  ms,
  raw,
  className,
  ...rest
}: { item: TrailItem; ms: number; raw?: string } & HTMLAttributes<HTMLDivElement>) {
  const [open, setOpen] = useState(false)
  const end = x.kind === 'end'
  const blocked = end && x.outcome === 'blocked'
  const Icon = !end ? BellRing : blocked ? TriangleAlert : CircleCheck
  const what = !end
    ? x.kind === 'hook'
      ? t('结束前拦住')
      : t('一轮结束后提醒')
    : blocked
      ? t('它说卡住了')
      : t('它说做完了')
  const result = !end
    ? x.tools
      ? t('之后调了 {n} 次工具', { n: x.tools })
      : t('之后没动手')
    : blocked
      ? x.need || ''
      : x.hidden
        ? t('收尾那句已隐藏')
        : ''
  const detail = end ? (blocked ? x.need : x.hidden) : x.text?.replace(LEAD_TAG, '')
  return (
    <div {...rest} data-life-trail className={cn(className, 'flex-wrap')}>
      <span className="shrink-0 text-subtle">{localStamp(ms).slice(11, 23)}</span>
      <span className="w-28 shrink-0">
        <span
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-sm px-1.5 py-px align-middle font-sans text-caption',
            blocked
              ? 'bg-warning/12 text-warning'
              : end
                ? 'bg-success/12 text-success'
                : 'bg-accent/12 text-accent-text',
          )}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span className="truncate">{what}</span>
        </span>
      </span>
      <button
        type="button"
        disabled={!detail}
        aria-expanded={detail ? open : undefined}
        onClick={() => setOpen(!open)}
        title={raw}
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted enabled:cursor-pointer enabled:hover:text-fg"
      >
        <span className="min-w-0 flex-1 truncate">{result}</span>
        {detail && (
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        )}
      </button>
      {open && detail && (
        <p className="ml-[calc(5.5rem+0.75rem)] basis-full border-l-2 border-line pl-3 font-sans whitespace-pre-wrap text-muted">
          {detail}
        </p>
      )}
    </div>
  )
}
