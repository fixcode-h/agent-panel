import { eventKind, type EventKind, type LogLine } from '@shared/lifecycle'
import type { TrailItem } from '@shared/end-turn'

/** 一行原始日志和解析结果（解析不了的 l 为空，原样显示） */
export type Parsed = { raw: string; l?: LogLine }

/** 日志的筛选：全部、关键事件（面板提醒、重试、出错、停止、退出），或者点计数块选的某一类 */
export type LogFilter = '' | 'key' | EventKind

/**
 * 日志列表的一行。at 是它在完整日志里的下标（合并的一对记两条）：
 * 筛选状态下双击某行要回到完整日志并定位到同一条，只能按原始下标对，不能按列表里的位置。
 * 面板提醒（trail）没有日志下标时记负数 -(序号+1)
 */
export type Row =
  | { kind: 'line'; raw: string; l?: LogLine; at: number[] }
  | { kind: 'pair'; req: LogLine; out: LogLine; at: number[] }
  | { kind: 'trail'; item: TrailItem; ms: number; raw?: string; at: number[] }
  | { kind: 'day'; day: string }

/** 提醒消息和日志里那行「面板提醒」事件的时间差在这之内就当成同一次（消息落盘和写日志前后差不到几秒） */
const SAME_MS = 5000

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
/** 本地时间的 YYYY-MM-DD HH:MM:SS.mmm，和日志行开头的格式一样（日志按本地时间写） */
export function localStamp(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * 筛选、合并「请求开始 + 开始输出」、把面板提醒和 end_turn 按时间插进日志、按天插分隔。
 * 面板提醒以前单独一张卡片（用户 2026-11-05 要求插进日志）：提醒在日志里本来就有一行「面板提醒」类事件，
 * 能对上的就用提醒那行顶替它（同一次不列两遍），对不上的和 end_turn 按时间单独插一行
 */
export function buildRows(lines: Parsed[], filter: LogFilter, merge: boolean, trail: TrailItem[] = []): Row[] {
  const kindOf = (x: Parsed) => (x.l ? eventKind(x.l.event, x.l.fields) : undefined)
  // 先把提醒对到日志行上：每条提醒找时间最近、还没被占的「面板提醒」行
  const byLine = new Map<number, TrailItem>()
  const loose: { item: TrailItem; ms: number; at: number }[] = []
  trail.forEach((item, i) => {
    const ms = Date.parse(item.at)
    if (Number.isNaN(ms)) return
    let best = -1
    if (item.kind !== 'end')
      lines.forEach((x, j) => {
        if (byLine.has(j) || !x.l || kindOf(x) !== 'nudges') return
        const d = Math.abs(x.l.at - ms)
        if (d <= SAME_MS && (best < 0 || d < Math.abs(lines[best].l!.at - ms))) best = j
      })
    if (best >= 0) byLine.set(best, item)
    else loose.push({ item, ms, at: -(i + 1) })
  })
  const keepKind = (k: EventKind | undefined, isTrail: boolean) => {
    if (!filter) return true
    if (isTrail) return filter === 'key' || filter === 'nudges'
    if (filter === 'key') return !!k && k !== 'requests'
    return k === filter
  }
  type Entry = (Parsed & { at: number }) | { trail: TrailItem; ms: number; at: number; raw?: string }
  const list: Entry[] = []
  let li = 0
  const pushLoose = (until: number) => {
    while (li < loose.length && loose[li].ms < until) {
      const x = loose[li++]
      if (keepKind(undefined, true)) list.push({ trail: x.item, ms: x.ms, at: x.at })
    }
  }
  lines.forEach((x, at) => {
    if (x.l) pushLoose(x.l.at)
    const t = byLine.get(at)
    if (t) {
      if (keepKind('nudges', true)) list.push({ trail: t, ms: x.l!.at, at, raw: x.raw })
      return
    }
    if (!filter) return list.push({ ...x, at })
    if (!x.l) return
    if (filter === 'requests' ? kindOf(x) === 'requests' || x.l.event === '模型开始输出' : keepKind(kindOf(x), false))
      list.push({ ...x, at })
  })
  pushLoose(Infinity)

  const out: Row[] = []
  let day = ''
  const dayOf = (d: string) => {
    if (d === day) return
    day = d
    out.push({ kind: 'day', day: d })
  }
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if ('trail' in e) {
      dayOf(localStamp(e.ms).slice(0, 10))
      out.push({ kind: 'trail', item: e.trail, ms: e.ms, raw: e.raw, at: [e.at] })
      continue
    }
    const { raw, l, at } = e
    if (l) dayOf(raw.slice(0, 10))
    const nx = list[i + 1]
    if (
      merge &&
      nx &&
      !('trail' in nx) &&
      l?.event === '模型请求开始' &&
      nx.l?.event === '模型开始输出' &&
      nx.l.fields.n === l.fields.n &&
      (nx.l.fields.step ?? '') === (l.fields.step ?? '')
    ) {
      out.push({ kind: 'pair', req: l, out: nx.l, at: [at, nx.at] })
      i++
    } else out.push({ kind: 'line', raw, l, at: [at] })
  }
  return out
}
