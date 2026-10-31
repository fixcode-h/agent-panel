import { useMemo } from 'react'
import { SCHEDULE_WEEKDAYS, weekStartOf, type Schedule } from '@shared/schedule'
import { hhmm } from '@shared/datetime'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { occurrencesIn, scheduleDot } from './occurrences'
import { OCC_TONE } from './ScheduleWeek'

/** 一格里最多列几条，再多写「还有 n 条」：格子高度固定，一个月看下来行是齐的 */
const PER_DAY = 3

/**
 * 计划页的月视图：6 行 × 7 列铺满这个月（前后补齐到整周），每格列出当天几点跑哪条。
 * 和周视图同一份数据（occurrencesIn）、同一套色调；点一条选中那条计划。
 * 双击一格在那天 9:00 新建；点日期或「还有 n 条」切到那一周的周视图看全
 */
export function ScheduleMonth({
  list,
  now,
  month,
  selected,
  onSelect,
  onCreate,
  onOpenDay,
}: {
  list: Schedule[]
  now: number
  /** 这个月 1 号 0 点 */
  month: number
  selected: string
  onSelect: (s: Schedule) => void
  /** 在某天新建（那天 9:00） */
  onCreate: (at: number) => void
  /** 切到这一天所在的周 */
  onOpenDay: (day: number) => void
}) {
  const first = weekStartOf(month)
  const days = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => {
        const d = new Date(first)
        d.setDate(d.getDate() + i)
        return d
      }),
    [first],
  )
  const events = useMemo(() => occurrencesIn(list, first, 42), [list, first])
  const todayStart = new Date(now).setHours(0, 0, 0, 0)
  const thisMonth = new Date(month).getMonth()

  return (
    <section aria-label={t('月视图')} className="flex min-w-[44rem] flex-col">
      <div className="frost sticky top-0 z-20 grid grid-cols-7 border-b">
        {SCHEDULE_WEEKDAYS.map((w) => (
          <span key={w.id} className="py-2 text-center text-[0.75rem] text-subtle">
            {w.label}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const end = new Date(d)
          end.setDate(end.getDate() + 1)
          const items = events.filter((e) => e.at >= d.getTime() && e.at < end.getTime())
          const today = d.getTime() === todayStart
          return (
            <div
              key={i}
              onDoubleClick={(e) => e.target === e.currentTarget && onCreate(new Date(d).setHours(9, 0, 0, 0))}
              title={t('双击在这天新建计划')}
              className={cn(
                'flex min-h-[7rem] flex-col gap-0.5 border-b p-1',
                i % 7 && 'border-l',
                i % 7 > 4 && 'bg-panel',
              )}
            >
              <button
                type="button"
                onClick={() => onOpenDay(d.getTime())}
                aria-label={t('看 {m} 月 {d} 日这一周', { m: d.getMonth() + 1, d: d.getDate() })}
                className={cn(
                  'mb-0.5 grid h-6 min-w-6 cursor-pointer place-items-center self-start rounded-full px-1 text-[0.75rem] font-semibold tabular-nums transition-colors',
                  today
                    ? 'bg-fg text-bg'
                    : cn('hover:bg-sel', d.getMonth() === thisMonth ? 'text-fg' : 'text-subtle/60'),
                )}
              >
                {d.getDate()}
              </button>
              {items.slice(0, PER_DAY).map((e, k) => (
                <button
                  key={`${e.s.id}-${k}`}
                  type="button"
                  aria-pressed={e.s.id === selected}
                  onClick={() => onSelect(e.s)}
                  title={`${e.s.name} · ${hhmm(new Date(e.at))}`}
                  className={cn(
                    'flex w-full min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left text-[0.6875rem] transition-colors',
                    OCC_TONE[e.tone],
                    e.s.id === selected && 'ring-1 ring-fg',
                  )}
                >
                  <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', scheduleDot(e.s.id))} />
                  <span className="shrink-0 tabular-nums opacity-85">{hhmm(new Date(e.at))}</span>
                  <span className="truncate font-medium">{e.s.name}</span>
                </button>
              ))}
              {items.length > PER_DAY && (
                <button
                  type="button"
                  onClick={() => onOpenDay(d.getTime())}
                  className="cursor-pointer self-start rounded px-1 text-[0.6875rem] text-subtle hover:bg-sel hover:text-fg"
                >
                  {t('还有 {n} 条', { n: items.length - PER_DAY })}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
