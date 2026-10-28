import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react'
import { SCHEDULE_WEEKDAYS, weekOccurrences, weekStartOf, type Schedule } from '@shared/schedule'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 一小时一行的高度（rem）：字号跟着设置走，行高也跟着 */
const ROW = 3
const DAY_MS = 86_400_000

/** ISO 周数（周一开头、包含 1 月 4 日的那周是第 1 周） */
function isoWeek(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const jan4 = new Date(d.getFullYear(), 0, 4)
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY_MS - 3 + ((jan4.getDay() + 6) % 7)) / 7)
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

/**
 * 计划页的周视图（照设计稿）：周一到周日 7 列、按小时排出这一周每条计划会在什么时候跑，
 * 能翻上一周 / 下一周，今天那一列标出来、画一条「现在」的线。点一条打开编辑。
 * 时刻全部来自 shared/schedule 的 weekOccurrences，这里只负责画
 */
export function ScheduleWeek({ list, now, onEdit }: { list: Schedule[]; now: number; onEdit: (s: Schedule) => void }) {
  const [start, setStart] = useState(() => weekStartOf(now))
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start)
        d.setDate(d.getDate() + i)
        return d
      }),
    [start],
  )
  const events = useMemo(
    () =>
      list
        .flatMap((s) => weekOccurrences(s, start).map((at) => ({ s, at })))
        .sort((a, b) => a.at - b.at || a.s.name.localeCompare(b.s.name)),
    [list, start],
  )
  // 显示的时段按这周实际有的计划收窄，前后各留一小时；一条都没有时给白天 8–20 点
  const hours = events.map((e) => new Date(e.at).getHours())
  const from = Math.max(0, hours.length ? Math.min(...hours) - 1 : 8)
  const to = Math.min(24, hours.length ? Math.max(...hours) + 2 : 20)
  const today = weekStartOf(now) === start ? (new Date(now).getDay() + 6) % 7 : -1
  const nowH = new Date(now).getHours() + new Date(now).getMinutes() / 60
  const last = days[6]
  const range = t('{y} 年 {m} 月 {d} 日 – {m2} 月 {d2} 日', {
    y: days[0].getFullYear(),
    m: days[0].getMonth() + 1,
    d: days[0].getDate(),
    m2: last.getMonth() + 1,
    d2: last.getDate(),
  })

  return (
    <section aria-label={t('周视图')} className="flex flex-col overflow-hidden rounded-xl bg-card shadow-card">
      <header className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('上一周')}
          onClick={() => setStart((s) => weekStartOf(s - DAY_MS))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setStart(weekStartOf(now))}>
          {t('本周')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('下一周')}
          onClick={() => setStart((s) => weekStartOf(s + 8 * DAY_MS))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="ml-1 text-[0.875rem] font-medium">{range}</span>
        <span className="text-[0.75rem] text-subtle">{t('第 {n} 周', { n: isoWeek(start) })}</span>
      </header>
      <div className="overflow-x-auto">
        <div className="min-w-[44rem]">
          {/* 星期表头：今天那天的日期画成实心圆 */}
          <div className="grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))] border-y">
            <span />
            {days.map((d, i) => (
              <div key={i} className="flex flex-col items-center gap-0.5 py-2">
                <span className="text-[0.6875rem] text-subtle">{SCHEDULE_WEEKDAYS[i].label}</span>
                <span
                  className={cn(
                    'grid h-7 min-w-7 place-items-center rounded-full px-1 text-[0.9375rem] font-semibold tabular-nums',
                    i === today ? 'bg-primary text-on-primary' : i > 4 ? 'text-subtle' : 'text-fg',
                  )}
                >
                  {d.getDate()}
                </span>
              </div>
            ))}
          </div>
          <div className="relative grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))]">
            {/* 时间刻度 */}
            <div>
              {Array.from({ length: to - from }, (_, i) => (
                <div
                  key={i}
                  style={{ height: `${ROW}rem` }}
                  className="pr-2 text-right font-mono text-[0.6875rem] text-subtle tabular-nums"
                >
                  {String(from + i).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            {days.map((_, col) => {
              const dayEvents = events.filter((e) => (new Date(e.at).getDay() + 6) % 7 === col)
              return (
                <div
                  key={col}
                  className={cn('relative border-l', col > 4 && 'bg-sel/20')}
                  style={{ height: `${(to - from) * ROW}rem` }}
                >
                  {Array.from({ length: to - from }, (_, i) => (
                    <div
                      key={i}
                      style={{ top: `${i * ROW}rem` }}
                      className="absolute inset-x-0 border-t border-line/60"
                    />
                  ))}
                  {col === today && nowH >= from && nowH < to && (
                    <div
                      aria-hidden
                      style={{ top: `${(nowH - from) * ROW}rem` }}
                      className="absolute inset-x-0 z-10 h-px bg-danger before:absolute before:-top-[3px] before:-left-[3px] before:h-[7px] before:w-[7px] before:rounded-full before:bg-danger"
                    />
                  )}
                  {dayEvents.map((e, i) => {
                    const at = new Date(e.at)
                    const h = at.getHours() + at.getMinutes() / 60
                    // 同一小时里有几条就在这一格里横着平分，不叠在一起
                    const peers = dayEvents.filter((x) => new Date(x.at).getHours() === at.getHours())
                    const k = peers.indexOf(e)
                    return (
                      <button
                        key={`${e.s.id}-${i}`}
                        type="button"
                        onClick={() => onEdit(e.s)}
                        title={`${e.s.name} · ${hhmm(e.at)}`}
                        style={{
                          top: `calc(${(h - from) * ROW}rem + 2px)`,
                          height: `calc(${ROW}rem - 4px)`,
                          left: `calc(${(k / peers.length) * 100}% + 2px)`,
                          width: `calc(${100 / peers.length}% - 4px)`,
                        }}
                        className="absolute flex cursor-pointer flex-col items-start gap-0.5 overflow-hidden rounded-md bg-run-soft px-1.5 py-1 text-left transition-colors hover:bg-run/20"
                      >
                        <span className="w-full truncate text-[0.75rem] font-medium text-fg">{e.s.name}</span>
                        <span className="flex items-center gap-1 font-mono text-[0.6875rem] text-run tabular-nums">
                          {hhmm(e.at)}
                          {e.s.repeat !== 'once' && <Repeat className="h-3 w-3" aria-label={t('重复')} />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
