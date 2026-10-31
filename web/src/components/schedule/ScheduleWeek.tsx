import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CalendarPlus, Pencil, Play, Repeat, Trash2 } from 'lucide-react'
import { SCHEDULE_WEEKDAYS, SLOT_MIN, type Schedule } from '@shared/schedule'
import { hhmm, pad2 } from '@shared/datetime'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { MenuItem, MenuSeparator, PointMenu } from '@/components/ui/menu'
import { occurrencesIn, scheduleDot, type OccTone } from './occurrences'

/** 一小时一行的高度（rem）：字号跟着设置走，行高也跟着 */
const ROW = 3
const DAY_MS = 86_400_000
/** 一格（半小时）占几小时：拖动、拉伸、右键新建都对齐到它 */
const SLOT_H = SLOT_MIN / 60
/** 一天的格数 */
const SLOTS = 24 / SLOT_H
/** 指针移动超过这么多像素才算拖动：手抖一下仍然是点击 */
const DRAG_PX = 4

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

/** 「14:30」：一天里第几小时（可以带半小时）写成时刻 */
const clock = (h: number) => `${pad2(Math.floor(h))}:${pad2(Math.round((h % 1) * 60))}`

/** 拖动中的那一块：移到了第几天、从第几小时开始、占几小时 */
interface Drag {
  key: string
  s: Schedule
  occAt: number
  kind: 'move' | 'resize'
  x: number
  y: number
  day: number
  h: number
  span: number
  moved: boolean
}

/**
 * 计划页的周视图：周一到周日 7 列、一整天按半小时一格，今天那一列画一条「现在」的红线。
 * - 点一块选中（右侧看详情），右键一块有编辑、立即执行、删除；
 * - 还没到的那几次能拖：拖动改执行时间（可以拖到别的天），拖底边改时长，都按半小时对齐；
 * - 空白格右键或双击：在那一格新建计划。
 * 时刻来自 occurrencesIn（排期规则在 shared/schedule），拖完怎么改规则由页面按 movedSchedule 算。翻周由页头控制
 */
export function ScheduleWeek({
  list,
  now,
  start,
  selected,
  onSelect,
  onCreate,
  onMove,
  onResize,
  onEdit,
  onRun,
  onDelete,
}: {
  list: Schedule[]
  now: number
  /** 这一周的周一 0 点 */
  start: number
  selected: string
  onSelect: (s: Schedule) => void
  /** 在某一格新建（那一格的开始时间） */
  onCreate: (at: number) => void
  /** 把 occAt 那一次拖到 to */
  onMove: (s: Schedule, occAt: number, to: number) => void
  /** 拖底边改了时长（分钟） */
  onResize: (s: Schedule, minutes: number) => void
  onEdit: (s: Schedule) => void
  onRun: (s: Schedule) => void
  onDelete: (s: Schedule) => void
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
  /** 每一块：开始在第几小时（带分钟的小数）、占几小时（计划的时长，至少半小时） */
  const events = useMemo(
    () =>
      occurrencesIn(list, start, 7).map((e) => {
        const at = new Date(e.at)
        return {
          ...e,
          key: `${e.s.id}@${e.at}`,
          h: at.getHours() + at.getMinutes() / 60,
          span: Math.max(SLOT_H, (e.s.durationMin || 60) / 60),
        }
      }),
    [list, start],
  )
  const todayStart = new Date(now).setHours(0, 0, 0, 0)
  const today = days.findIndex((d) => d.getTime() === todayStart)
  const nowH = new Date(now).getHours() + new Date(now).getMinutes() / 60

  const cols = useRef<(HTMLDivElement | null)[]>([])
  const box = useRef<HTMLElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag
  /** 右键菜单：空白格（新建）或某一块（编辑、执行、删除） */
  const [menu, setMenu] = useState<{ x: number; y: number; at?: number; s?: Schedule } | null>(null)

  // 翻到一周时滚到有内容的地方：这周有今天就到现在前一小时，否则到这周最早的一块（都没有时到 8 点）
  useEffect(() => {
    const scroller = box.current?.parentElement
    if (!scroller) return
    const first = Math.min(...events.map((e) => e.h), 24)
    const h = Math.max(0, (today >= 0 ? nowH : first < 24 ? first : 9) - 1)
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    scroller.scrollTop = h * ROW * rem
    // 只在换周时滚一次：轮询刷新数据不能把用户滚到的位置拉回去
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [start])

  /** 指针所在的那一天（拖到表外按最近的一天） */
  const dayAt = (x: number) => {
    let best = 0
    let dist = Infinity
    cols.current.forEach((el, i) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
      if (d < dist) {
        dist = d
        best = i
      }
    })
    return best
  }
  /** 一格的像素高度：字号跟着设置走，每次现量 */
  const slotPx = () => (cols.current[0]?.getBoundingClientRect().height ?? 0) / SLOTS

  const begin = (e: ReactPointerEvent, ev: (typeof events)[number], kind: Drag['kind']) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const d: Drag = {
      key: ev.key,
      s: ev.s,
      occAt: ev.at,
      kind,
      x: e.clientX,
      y: e.clientY,
      day: dayAt(e.clientX),
      h: ev.h,
      span: ev.span,
      moved: false,
    }
    const origin = { day: d.day, h: ev.h, span: ev.span }
    setDrag(d)
    // 拖到滚动区上下边缘时自动滚：看不见的时段也能拖过去。位移要把滚过的距离算进去
    const scroller = box.current?.parentElement
    const scroll0 = scroller?.scrollTop ?? 0
    let last = { x: e.clientX, y: e.clientY }
    let timer = 0
    const edge = () => {
      // 还没拖起来（只是按住）时不滚
      if (!scroller || !dragRef.current?.moved) return
      const r = scroller.getBoundingClientRect()
      const step = last.y < r.top + 48 ? -12 : last.y > r.bottom - 32 ? 12 : 0
      if (step) {
        scroller.scrollTop += step
        update(last)
      }
    }
    const update = (m: { x: number; y: number }) => {
      const cur = dragRef.current
      if (!cur) return
      const dx = m.x - d.x
      const dy = m.y - d.y + ((scroller?.scrollTop ?? 0) - scroll0)
      if (!cur.moved && Math.hypot(dx, dy) < DRAG_PX) return
      const steps = Math.round(dy / (slotPx() || 1))
      if (kind === 'resize') {
        const span = Math.max(SLOT_H, Math.min(24 - origin.h, origin.span + steps * SLOT_H))
        setDrag({ ...cur, span, moved: true })
      } else {
        const h = Math.max(0, Math.min(24 - SLOT_H, origin.h + steps * SLOT_H))
        setDrag({ ...cur, day: dayAt(m.x), h, moved: true })
      }
    }
    const move = (m: PointerEvent) => {
      last = { x: m.clientX, y: m.clientY }
      update(last)
    }
    timer = window.setInterval(edge, 30)
    const up = () => {
      window.clearInterval(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', esc)
      const cur = dragRef.current
      setDrag(null)
      if (!cur) return
      if (!cur.moved) return kind === 'move' ? onSelect(ev.s) : undefined
      if (kind === 'resize') {
        if (cur.span !== origin.span) onResize(ev.s, Math.round(cur.span * 60))
        return
      }
      if (cur.day === origin.day && cur.h === origin.h) return
      const to = new Date(days[cur.day])
      to.setHours(Math.floor(cur.h), Math.round((cur.h % 1) * 60), 0, 0)
      onMove(ev.s, ev.at, to.getTime())
    }
    // Esc 放弃这次拖动，回到原位
    const esc = (k: KeyboardEvent) => {
      if (k.key !== 'Escape') return
      dragRef.current = null
      up()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', esc)
  }

  /** 第 day 天、从第 h 小时开始的那一格结束的时刻：拖到这里会不会是过去 */
  const slotEnd = (day: number, h: number) => {
    const d = new Date(days[day])
    d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0)
    return d.getTime() + SLOT_MIN * 60_000
  }

  /** 空白格的开始时间 */
  const slotAt = (col: number, slot: number) => {
    const d = new Date(days[col])
    d.setHours(Math.floor(slot * SLOT_H), (slot % (1 / SLOT_H)) * SLOT_MIN, 0, 0)
    return d.getTime()
  }

  return (
    <section ref={box} aria-label={t('周视图')} className={cn('min-w-[44rem]', drag?.moved && 'select-none')}>
      {/* 星期表头：吸在滚动区顶上，往下滚时间还能对上是哪天 */}
      <div className="frost sticky top-0 z-20 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b">
        <span />
        {days.map((d, i) => (
          <div key={i} className="border-l">
            <DayHead label={SCHEDULE_WEEKDAYS[i].label} date={d.getDate()} today={i === today} weekend={i > 4} />
          </div>
        ))}
      </div>
      <div className="relative grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
        {/* 时间刻度：整点写时刻，字往上提半行和格线对齐；第一格不写，免得贴着表头 */}
        <div>
          {Array.from({ length: 24 }, (_, i) => (
            <div
              key={i}
              style={{ height: `${ROW}rem` }}
              className="-translate-y-[0.45rem] pr-2 text-right font-mono text-[0.6875rem] text-subtle tabular-nums"
            >
              {i ? `${pad2(i)}:00` : ''}
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
              ref={(el) => {
                cols.current[col] = el
              }}
              className={cn('relative border-l', col > 4 && 'bg-panel')}
              style={{ height: `${24 * ROW}rem` }}
            >
              {/* 半小时一格：整点实线、半点虚线；悬停的那一格浅底，右键或双击在这一格新建 */}
              {Array.from({ length: SLOTS }, (_, i) => (
                <div
                  key={i}
                  data-slot={clock(i * SLOT_H)}
                  style={{ top: `${i * SLOT_H * ROW}rem`, height: `${SLOT_H * ROW}rem` }}
                  className={cn(
                    'absolute inset-x-0 transition-colors hover:bg-sel/45',
                    i > 0 && (i % 2 ? 'border-t border-dashed border-line/60' : 'border-t'),
                  )}
                  onDoubleClick={() => onCreate(slotAt(col, i))}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, at: slotAt(col, i) })
                  }}
                />
              ))}
              {col === today && (
                <div
                  aria-hidden
                  style={{ top: `${nowH * ROW}rem` }}
                  className="pointer-events-none absolute inset-x-0 z-10 h-0.5 -translate-y-1/2 bg-danger before:absolute before:top-1/2 before:-left-1 before:h-2.5 before:w-2.5 before:-translate-y-1/2 before:rounded-full before:bg-danger"
                />
              )}
              {dayEvents.map((e) => {
                const h = e.h
                // 时段有重叠的几条横着平分，不叠在一起
                const peers = dayEvents.filter((x) => x.h < h + e.span && h < x.h + x.span)
                const k = peers.indexOf(e)
                // 画到当天的底为止：跨过午夜的长任务不往下一天的格子里伸
                const live = drag?.key === e.key && drag.moved ? drag : null
                const span = Math.min(live?.span ?? e.span, 24 - h)
                const on = e.s.id === selected
                // 已经过去的那几次是运行记录，只能看不能拖
                const movable = e.tone === 'upcoming'
                return (
                  <button
                    key={e.key}
                    type="button"
                    aria-pressed={on}
                    data-occ={e.s.name}
                    // 键盘按回车选中；指针的点击在 pointerup 里判（拖过就不算点）
                    onClick={(m) => m.detail === 0 && onSelect(e.s)}
                    onPointerDown={(m) => (movable ? begin(m, e, 'move') : m.button === 0 && onSelect(e.s))}
                    onContextMenu={(m) => {
                      m.preventDefault()
                      m.stopPropagation()
                      setMenu({ x: m.clientX, y: m.clientY, s: e.s })
                    }}
                    title={`${e.s.name} · ${clock(h)}–${clock(Math.min(24, h + e.span))}${movable ? `\n${t('拖动改时间，拖底边改时长')}` : ''}`}
                    style={{
                      top: `calc(${h * ROW}rem + 1px)`,
                      height: `calc(${span * ROW}rem - 3px)`,
                      left: `calc(${(k / peers.length) * 100}% + 3px)`,
                      width: `calc(${100 / peers.length}% - 6px)`,
                    }}
                    className={cn(
                      'absolute z-[1] flex flex-col items-start justify-start gap-px overflow-hidden rounded-md px-1.5 py-1 text-left transition-colors',
                      OCC_TONE[e.tone],
                      movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                      on && 'z-[2] ring-[1.5px] ring-fg/55',
                      drag?.key === e.key && drag.moved && drag.kind === 'move' && 'opacity-40',
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-1 text-[0.75rem] font-semibold">
                      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', scheduleDot(e.s.id))} />
                      <span className="truncate">{e.s.name}</span>
                    </span>
                    <span className="flex items-center gap-1 text-[0.6875rem] tabular-nums opacity-85">
                      {clock(h)}–{clock(Math.min(24, h + span))}
                      {e.s.repeat !== 'once' && <Repeat className="h-2.5 w-2.5" aria-label={t('重复')} />}
                    </span>
                    {/* 底边：拖它改时长 */}
                    {movable && (
                      <span
                        aria-hidden
                        onPointerDown={(m) => begin(m, e, 'resize')}
                        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                      />
                    )}
                  </button>
                )
              })}
              {/* 拖到的位置：虚线框 + 新时间，松手才保存 */}
              {drag?.moved &&
                drag.kind === 'move' &&
                drag.day === col &&
                (() => {
                  // 不重复的计划拖到已经过去的那几格：松手不会改，框先变红说清楚，不等松手后才报错
                  const past = drag.s.repeat === 'once' && slotEnd(drag.day, drag.h) <= now
                  return (
                    <div
                      aria-hidden
                      style={{ top: `calc(${drag.h * ROW}rem + 1px)`, height: `calc(${drag.span * ROW}rem - 3px)` }}
                      className={cn(
                        'pointer-events-none absolute inset-x-[3px] z-[3] flex flex-col rounded-md border-2 border-dashed px-1.5 py-1 text-[0.6875rem] font-medium tabular-nums',
                        past ? 'border-danger bg-danger/10 text-danger' : 'border-accent bg-accent/10 text-accent-text',
                      )}
                    >
                      <span className="truncate">{drag.s.name}</span>
                      {clock(drag.h)}–{clock(Math.min(24, drag.h + drag.span))}
                      {past && <span>{t('已过去，不能挪到这里')}</span>}
                    </div>
                  )
                })()}
            </div>
          )
        })}
      </div>
      <PointMenu at={menu} open={!!menu} onOpenChange={(o) => !o && setMenu(null)}>
        {menu?.s ? (
          <>
            <MenuItem onSelect={() => onEdit(menu.s!)}>
              <Pencil className="h-4 w-4" />
              {t('编辑')}
            </MenuItem>
            <MenuItem onSelect={() => onRun(menu.s!)}>
              <Play className="h-4 w-4" />
              {t('立即执行')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => onDelete(menu.s!)}>
              <Trash2 className="h-4 w-4" />
              {t('删除')}
            </MenuItem>
          </>
        ) : (
          menu?.at !== undefined && (
            <MenuItem onSelect={() => onCreate(menu.at!)}>
              <CalendarPlus className="h-4 w-4" />
              {t('在 {day} {time} 新建计划', {
                day: SCHEDULE_WEEKDAYS[(new Date(menu.at).getDay() + 6) % 7].label,
                time: hhmm(new Date(menu.at)),
              })}
            </MenuItem>
          )
        )}
      </PointMenu>
    </section>
  )
}
