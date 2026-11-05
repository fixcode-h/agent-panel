import { useState } from 'react'
import { BellRing, ChevronRight, CircleCheck, TriangleAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TrailItem } from '@shared/end-turn'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { LEAD_TAG } from './panel-kind'

/**
 * 状态诊断里的「面板提醒」卡片：面板的提醒（结束前钩子拦住、一轮结束后补发）和 Agent 用 end_turn 交代的结束，
 * 按时间列出来。提醒和 end_turn 都不画进对话（用户 2026-11-05 定），这里是唯一能看到它们的地方。
 * 每行的结果按结构算（提醒之后调了几次工具、end_turn 的 outcome），不看回复文字
 */
export function ReminderTrail({ items }: { items: TrailItem[] }) {
  const reminders = items.filter((x) => x.kind !== 'end').length
  return (
    <Card className="flex min-w-0 flex-col gap-1 px-3.5 py-3" data-life-trail>
      <span className="text-footnote text-subtle">
        {t('面板提醒')} · {t('{n} 次', { n: reminders })}
      </span>
      <ul className="flex flex-col">
        {[...items].reverse().map((x, i) => (
          <TrailRow key={`${x.at}-${i}`} item={x} />
        ))}
      </ul>
    </Card>
  )
}

const clock = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false })
}

function TrailRow({ item: x }: { item: TrailItem }) {
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
    <li className="min-w-0">
      <button
        type="button"
        disabled={!detail}
        aria-expanded={detail ? open : undefined}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-body enabled:hover:bg-sel"
      >
        <span className="w-16 shrink-0 font-mono text-caption text-subtle tabular-nums">{clock(x.at)}</span>
        <Icon className={cn('h-3.5 w-3.5 shrink-0', blocked ? 'text-warning' : end ? 'text-success' : 'text-subtle')} />
        <span className="shrink-0 text-fg">{what}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{result}</span>
        {detail && (
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        )}
      </button>
      {open && detail && (
        <p className="mt-0.5 mb-1.5 ml-[4.5rem] border-l-2 border-line pl-3 text-footnote whitespace-pre-wrap text-muted">
          {detail}
        </p>
      )}
    </li>
  )
}
