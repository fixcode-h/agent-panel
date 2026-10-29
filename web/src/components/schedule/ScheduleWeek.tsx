import { useMemo } from 'react'
import { Repeat } from 'lucide-react'
import { SCHEDULE_WEEKDAYS, type Schedule } from '@shared/schedule'
import { hhmm } from '@shared/datetime'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { lastDurationMs, occurrencesIn, scheduleDot, type OccTone } from './occurrences'

/** 一小时一行的高度（rem）：字号跟着设置走，行高也跟着 */
const ROW = 3
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** ISO 周数（周一开头、包含 1 月 4 日的那周是第 1 周） */
export function isoWeek(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const jan4 = new Date(d.getFullYear(), 0, 4)
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY_MS - 3 + ((jan4.getDay() + 6) % 7)) / 7)
}

/** 计划块的底色：没到的是中性底，跑成功的绿、没跑成的红（照设计稿，只用底色分，不描边） */
export const OCC_TONE: Record<OccTone, string> = {
  upcoming: 'bg-field text-fg hover:bg-sel',
  ok: 'bg-success/12 text-success hover:bg-success/18',
  err: 'bg-danger/10 text-danger hover:bg-danger/16',
}

/** 星期几 + 日期的表头：今天的日期画成实心圆，周末的字淡一档 */
export function DayHead({
  label,
  date,
  today,
  weekend,
}: {
  label: string
  date: number
  today: boolean
  weekend: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-2">
      <span className="text-[0.75rem] text-subtle">{label}</span>
      <span
        className={cn(
          'grid h-8 min-w-8 place-items-center rounded-full px-1 text-[1.0625rem] font-semibold tabular-nums',
          today ? 'bg-fg text-bg' : weekend ? 'text-subtle' : 'text-fg',
        )}
      >
        {date}
      </span>
    </div>
  )
}

/**
 * 计划页的周视图（照设计稿）：周一到周日 7 列、按小时排出这一周每条计划什么时候跑，
 * 今天那一列的日期画成圆、画一条「现在」的红线；点一格选中那条计划（右侧看详情）。
 * 时刻来自 occurrencesIn（排期规则在 shared/schedule），这里只负责画。翻周由页头控制
 */
export function ScheduleWeek({
  list,
  now,
  start,
  selected,
  onSelect,
}: {
  list: Schedule[]
  now: number
  /** 这一周的周一 0 点 */
  start: number
  selected: string
  onSelect: (s: Schedule) => void
}) {
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start)
        d.setDate(d.getDate() + i)
        return d
      }),
    [start],
  )
  /**
   * 每一格计划块：开始在第几小时（带分钟的小数）、画多少小时。
   * 计划本身没有时长，用这条计划最近一次跑完的耗时当高度；没有耗时的、或者跑得很快的都至少画一个时间格，
   * 放得下名字和时间。同一天里时段有重叠的横着平分，不叠在一起
   */
  const events = useMemo(
    () =>
      occurrencesIn(list, start, 7).map((e) => {
        const at = new Date(e.at)
        return { ...e, h: at.getHours() + at.getMinutes() / 60, span: Math.max(1, lastDurationMs(e.s) / HOUR_MS) }
      }),
    [list, start],
  )
  // 时段至少画 7–21 点（一天里常用的那段），这周有更早 / 更晚的计划时往外扩，前面留一小时、块的下面留一小时
  const from = Math.max(0, Math.min(7, ...events.map((e) => Math.floor(e.h) - 1)))
  const to = Math.min(24, Math.max(21, ...events.map((e) => Math.ceil(e.h + e.span) + 1)))
  const todayStart = new Date(now).setHours(0, 0, 0, 0)
  const today = days.findIndex((d) => d.getTime() === todayStart)
  const nowH = new Date(now).getHours() + new Date(now).getMinutes() / 60

  return (
    <section aria-label={t('周视图')} className="min-w-[44rem]">
      {/* 星期表头：吸在滚动区顶上，往下滚时间还能对上是哪天 */}
      <div className="sticky top-0 z-20 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b bg-bg">
        <span />
        {days.map((d, i) => (
          <div key={i} className="border-l">
            <DayHead label={SCHEDULE_WEEKDAYS[i].label} date={d.getDate()} today={i === today} weekend={i > 4} />
          </div>
        ))}
      </div>
      <div className="relative grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
        {/* 时间刻度：字往上提半行，和格线对齐；第一格不写，免得贴着表头 */}
        <div>
          {Array.from({ length: to - from }, (_, i) => (
            <div
              key={i}
              style={{ height: `${ROW}rem` }}
              className="-translate-y-[0.45rem] pr-2 text-right font-mono text-[0.6875rem] text-subtle tabular-nums"
            >
              {i ? `${String(from + i).padStart(2, '0')}:00` : ''}
            </div>
          ))}
        </div>
        {days.map((d, col) => {
          // 按本地日历的这一天筛（跨夏令时那天不是 24 小时，不能拿 DAY_MS 算）
          const end = new Date(d)
          end.setDate(end.getDate() + 1)
          const dayEvents = events.filter((e) => e.at >= d.getTime() && e.at < end.getTime())
          return (
            <div
              key={col}
              className={cn('relative border-l', col > 4 && 'bg-panel')}
              style={{ height: `${(to - from) * ROW}rem` }}
            >
              {Array.from({ length: to - from - 1 }, (_, i) => (
                <div key={i} style={{ top: `${(i + 1) * ROW}rem` }} className="absolute inset-x-0 border-t" />
              ))}
              {col === today && nowH >= from && nowH < to && (
                <div
                  aria-hidden
                  style={{ top: `${(nowH - from) * ROW}rem` }}
                  className="absolute inset-x-0 z-10 h-0.5 -translate-y-1/2 bg-danger before:absolute before:top-1/2 before:-left-1 before:h-2.5 before:w-2.5 before:-translate-y-1/2 before:rounded-full before:bg-danger"
                />
              )}
              {dayEvents.map((e, i) => {
                const at = new Date(e.at)
                const h = e.h
                // 时段有重叠的几条横着平分，不叠在一起
                const peers = dayEvents.filter((x) => x.h < h + e.span && h < x.h + x.span)
                const k = peers.indexOf(e)
                // 画到当天的底为止：跨过午夜的长任务不往下一天的格子里伸
                const span = Math.min(e.span, to - h)
                const on = e.s.id === selected
                return (
                  <button
                    key={`${e.s.id}-${i}`}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onSelect(e.s)}
                    title={`${e.s.name} · ${hhmm(at)}`}
                    style={{
                      top: `calc(${(h - from) * ROW}rem + 1px)`,
                      height: `calc(${span * ROW}rem - 3px)`,
                      left: `calc(${(k / peers.length) * 100}% + 3px)`,
                      width: `calc(${100 / peers.length}% - 6px)`,
                    }}
                    className={cn(
                      'absolute flex cursor-pointer flex-col items-start justify-start gap-px overflow-hidden rounded-md px-1.5 py-1 text-left transition-colors',
                      OCC_TONE[e.tone],
                      on && 'z-[2] ring-2 ring-fg',
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-1 text-[0.75rem] font-semibold">
                      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', scheduleDot(e.s.id))} />
                      <span className="truncate">{e.s.name}</span>
                    </span>
                    <span className="flex items-center gap-1 text-[0.6875rem] tabular-nums opacity-85">
                      {hhmm(at)}
                      {e.s.repeat !== 'once' && <Repeat className="h-2.5 w-2.5" aria-label={t('重复')} />}
                    </span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </section>
  )
}
