import { isoWeekday, nextRunAt, SCHEDULE_WEEKDAYS, weekOccurrences, weekStartOf, willRunAgain } from '@shared/schedule'
import type { Schedule } from '@shared/schedule'
import { hhmm, pad2 } from '@shared/datetime'

const DAY_MS = 86_400_000

/** 日历上一格的色调：还没到的 / 跑成功的 / 没跑成的（失败、错过、上游没成功） */
export type OccTone = 'upcoming' | 'ok' | 'err'

export interface Occurrence {
  s: Schedule
  at: number
  tone: OccTone
}

/**
 * 日历（周视图、月视图）在 [from, from + days 天) 里要画的每一次执行。
 * 还没到的来自 shared/schedule 的 weekOccurrences（和服务端排期同一套规则）；
 * 已经过去的读运行记录（runs 里排期到点的那次 at），按结果着色——重复计划跑完 at 会往后推，
 * 只看 weekOccurrences 的话本周已经跑过的几天会是空的，看不出跑没跑成。手动执行不对应排期，不画。
 */
export function occurrencesIn(list: Schedule[], from: number, days: number): Occurrence[] {
  const end = new Date(from)
  end.setDate(end.getDate() + days)
  const to = end.getTime()
  const seen = new Set<string>()
  const out: Occurrence[] = []
  const add = (s: Schedule, at: number, tone: OccTone) => {
    // 同一条计划同一分钟只画一格：运行记录优先（它带着结果）
    const key = `${s.id}@${Math.floor(at / 60_000)}`
    if (at < from || at >= to || seen.has(key)) return
    seen.add(key)
    out.push({ s, at, tone })
  }
  for (const s of list) {
    for (const r of s.runs) {
      if (r.manual || !r.at) continue
      const at = Date.parse(r.at)
      if (Number.isFinite(at)) add(s, at, r.event === 'run' ? 'ok' : 'err')
    }
    for (let w = weekStartOf(from); w < to; w = weekStartOf(w + 8 * DAY_MS)) {
      for (const at of weekOccurrences(s, w)) add(s, at, 'upcoming')
    }
  }
  return out.sort((a, b) => a.at - b.at || a.s.name.localeCompare(b.s.name))
}

/** 接下来几次执行（详情面板的「接下来」）：第一次就是 at，之后按 nextRunAt 一次次往后推；不会再跑时为空 */
export function upcomingRuns(s: Schedule, count = 4): number[] {
  if (!willRunAgain(s)) return []
  const first = Date.parse(s.at)
  if (!Number.isFinite(first)) return []
  const out = [first]
  if (s.repeat === 'once') return out
  while (out.length < count) {
    const next = Date.parse(nextRunAt(s, out[out.length - 1]))
    if (!Number.isFinite(next) || next <= out[out.length - 1]) break
    out.push(next)
  }
  return out
}

/** 「10-29 周四 09:00」：详情面板里一次执行的时间，日期和星期都在，不用再换算 */
export function dayTimeLabel(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${SCHEDULE_WEEKDAYS[isoWeekday(d) - 1].label} ${hhmm(d)}`
}

/**
 * 每条计划一个固定的标识色（名字前的小圆点）：按 id 取，翻周、刷新都不变。
 * 只用主题里的状态色 token，不硬编码颜色；成功 / 警告色留给结果，不拿来当标识
 */
const DOTS = ['bg-run', 'bg-accent', 'bg-peer', 'bg-focus', 'bg-muted'] as const
export function scheduleDot(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return DOTS[h % DOTS.length]
}
