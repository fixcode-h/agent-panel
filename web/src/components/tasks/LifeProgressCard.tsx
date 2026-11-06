import { t } from '@shared/i18n'
import type { LifeNode } from '@shared/lifecycle'
import { convStateText } from '@shared/task'
import { fmtDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'

/**
 * 状态诊断的「推进」卡：这个对话做到哪了、在等谁、面板推了几次、上一次怎么结束的。
 * 这些事实服务端早就收集了（LifeFacts 的 plan、waitsOn、nudge、runningTool，trail 里的 end_turn），
 * 以前只给诊断文件和 AI 分析用，弹窗里看不到（用户 2026-11-06 要求扩充状态面板）。
 * 结束交代只认 end_turn 的记录，不读回复文字（ADR 0041、0049）
 */
export function LifeProgressCard({ node, now }: { node: LifeNode; now: number }) {
  const f = node.facts
  const plan = f.plan
  const end = node.trail?.filter((x) => x.kind === 'end').at(-1)
  const endMs = end ? Date.parse(end.at) : NaN
  const ago = Number.isNaN(endMs) ? '' : t('{d} 前', { d: fmtDuration(Math.max(0, now - endMs)) })
  const rows: [string, string][] = [
    [
      t('计划'),
      plan
        ? [
            t('{done}/{total} 步', { done: plan.done, total: plan.total }),
            plan.waiting ? t('在等 {n} 步', { n: plan.waiting }) : '',
            plan.open ? t('还剩 {n} 步', { n: plan.open }) : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : t('没有计划'),
    ],
    [t('正在跑的工具'), f.runningTool || '—'],
    ...(f.nudge ? [[t('面板推进'), t('同一进度推了 {n} 次', { n: f.nudge.n })] as [string, string]] : []),
    [t('上次结束'), end ? [end.outcome === 'blocked' ? t('卡住') : t('做完'), ago].filter(Boolean).join(' · ') : '—'],
  ]
  return (
    <Card className="flex min-w-0 flex-col gap-2 px-3.5 py-3" data-life-progress>
      <span className="flex min-w-0 items-center justify-between gap-2 text-footnote text-subtle">
        {t('推进')}
        {plan && (
          <span className="min-w-0 truncate" title={plan.title}>
            {plan.title}
          </span>
        )}
      </span>
      {plan && plan.total > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-sel" aria-hidden>
          <div className="h-full rounded-full bg-success" style={{ width: `${(plan.done / plan.total) * 100}%` }} />
        </div>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-subtle">{k}</dt>
            <dd className="truncate text-right text-fg tabular-nums" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {f.waitsOn.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={t('在等的子对话')}>
          {f.waitsOn.map((w) => (
            <li
              key={w.id}
              className="flex min-w-0 items-center gap-1.5 rounded-md bg-sel/60 px-2 py-0.5 text-caption"
              title={w.title}
            >
              <span className="min-w-0 flex-1 truncate text-muted">{w.title || w.id}</span>
              <span className={cn('shrink-0', w.wrapAt ? 'text-warning' : 'text-subtle')}>
                {w.wrapAt ? t('请你收尾') : convStateText(w.state)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
