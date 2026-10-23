import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { t } from '@shared/i18n'
import { dayKey, usagePeriod, type UsageGrain } from '@shared/usage'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'

/** 显示月份里的 42 个格子：1 号所在周的周一开始，前后月补齐，固定 6 行高度不跳 */
function cellsOf(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    return { day, inMonth: day.getMonth() === month.getMonth() }
  })
}

const WEEKDAYS = [t('一'), t('二'), t('三'), t('四'), t('五'), t('六'), t('日')]

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * 按天 / 按周 / 按月共用的时间选择器：‹ 标签 ›，点标签打开月历。
 * 月历里点某一天，就切到它所在的区间（按周选那一周、按月选那个月），高亮整个区间；
 * 有数据的日子底下带圆点，翻月按钮在数据范围外时禁用。
 */
export function PeriodPicker({
  grain,
  start,
  marked,
  min,
  max,
  onChange,
  label,
}: {
  grain: UsageGrain
  /** 当前区间第一天 */
  start: Date
  /** 有数据的日期（dayKey） */
  marked: Set<string>
  /** 数据覆盖的最早 / 最晚一天 */
  min: Date
  max: Date
  onChange: (day: Date) => void
  /** 触发按钮上的文字（区间标签 + 回退说明的 title） */
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => new Date(start.getFullYear(), start.getMonth(), 1))
  // 每次打开都回到当前区间所在的月份；区间是在弹层里选的，开着时不再跟着跳月
  useEffect(() => {
    if (open) setMonth(new Date(start.getFullYear(), start.getMonth(), 1))
    // 只在打开时定位一次，选择过程中翻月不能被拉回去
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const period = useMemo(() => usagePeriod(grain, start), [grain, start])
  const cells = useMemo(() => cellsOf(month), [month])
  const today = new Date()
  const dayBefore = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  const dayAfter = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  const canPrev = dayBefore(period.start) >= min
  const canNext = dayAfter(period.end) <= max
  const pick = (day: Date) => {
    onChange(day)
    setOpen(false)
  }
  const canStep = (n: number) => {
    const m = new Date(month.getFullYear(), month.getMonth() + n, 1)
    const last = new Date(m.getFullYear(), m.getMonth() + 1, 0)
    return last >= min && m <= max
  }

  return (
    <div className="inline-flex items-center rounded-lg border border-line-strong bg-field">
      <button
        type="button"
        aria-label={t('上一区间（[）')}
        title={t('上一区间（[）')}
        disabled={!canPrev}
        onClick={() => onChange(dayBefore(period.start))}
        className="grid h-8 w-7 cursor-pointer place-items-center rounded-l-lg text-muted hover:bg-sel hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('选择时间范围（{range}）', { range: label })}
            title={t('选择时间范围（{range}）', { range: label })}
            data-usage-period-trigger
            className="h-8 max-w-[260px] cursor-pointer truncate border-x px-2.5 text-[0.8125rem] font-medium whitespace-nowrap hover:bg-sel"
          >
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[286px] p-2.5" align="start">
          <div className="mb-1.5 flex items-center gap-1">
            <button
              type="button"
              aria-label={t('上个月')}
              title={t('上个月')}
              disabled={!canStep(-1)}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted hover:bg-sel hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="flex-1 text-center text-[0.8125rem] font-medium">
              {t('{y}年{m}月', { y: month.getFullYear(), m: month.getMonth() + 1 })}
            </span>
            <button
              type="button"
              aria-label={t('下个月')}
              title={t('下个月')}
              disabled={!canStep(1)}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted hover:bg-sel hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[0.6875rem] text-subtle">
            {WEEKDAYS.map((w) => (
              <span key={w} className="py-1">
                {w}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5" aria-label={t('选择日期')} data-usage-calendar>
            {cells.map(({ day, inMonth }) => {
              const key = dayKey(day)
              const picked = day >= period.start && day <= period.end
              const isToday = sameDay(day, today)
              const off = day < min || day > max
              return (
                <button
                  key={key}
                  type="button"
                  disabled={off}
                  aria-label={
                    marked.has(key)
                      ? t('{y}年{m}月{d}日，有数据', { y: day.getFullYear(), m: day.getMonth() + 1, d: day.getDate() })
                      : t('{y}年{m}月{d}日', { y: day.getFullYear(), m: day.getMonth() + 1, d: day.getDate() })
                  }
                  aria-pressed={picked}
                  onClick={() => pick(day)}
                  className={cn(
                    'relative grid h-8 cursor-pointer place-items-center rounded-lg text-[0.78125rem] tabular-nums transition-colors',
                    !inMonth && 'opacity-40',
                    picked ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/60 hover:text-fg',
                    isToday && !picked && 'ring-1 ring-accent/60',
                    grain === 'day' && picked && 'bg-accent text-white hover:bg-accent',
                    off && 'cursor-not-allowed opacity-25',
                  )}
                >
                  {day.getDate()}
                  {marked.has(key) && (
                    <span
                      className={cn(
                        'absolute bottom-0.5 h-1 w-1 rounded-full',
                        grain === 'day' && picked ? 'bg-white' : 'bg-accent',
                      )}
                    />
                  )}
                </button>
              )
            })}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 border-t pt-2">
            <Button variant="ghost" size="sm" onClick={() => pick(today)}>
              {t('今天')}
            </Button>
            <span className="ml-auto text-[0.6875rem] text-subtle">
              {grain === 'day' ? t('点一天看那天的用量') : grain === 'week' ? t('点一天看那一周') : t('点一天看那个月')}
            </span>
          </div>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label={t('下一区间（]）')}
        title={t('下一区间（]）')}
        disabled={!canNext}
        onClick={() => onChange(dayAfter(period.end))}
        className="grid h-8 w-7 cursor-pointer place-items-center rounded-r-lg text-muted hover:bg-sel hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}
