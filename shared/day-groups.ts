/** 列表按自然日分组（今天，其余写日期）：从 task.ts 拆出来，task.ts 原样转出 */
import { t, uiLocale } from './i18n.ts'

/**
 * 任务列表按自然日分组：同一天的归到一组，组内保持传进来的顺序（列表本来就按时间倒序）。
 * 只有今天用相对说法，昨天起都写日期（用户要求：「昨天」「前天」要换算才知道是哪天）；不是今年的带上年份。
 * now 只有测试会传，正常用当前时间。
 */
export function groupByDay<T>(list: T[], at: (x: T) => string, now = new Date()) {
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = dayStart(now)
  const groups = new Map<string, { key: string; label: string; items: T[] }>()
  for (const x of list) {
    const d = new Date(at(x))
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    let g = groups.get(key)
    if (!g) {
      const day = dayStart(d)
      g = {
        key,
        label: day === today ? t('今天') : dayLabel(d, now),
        items: [],
      }
      groups.set(key, g)
    }
    g.items.push(x)
  }
  return [...groups.values()]
}

/** 今天以外那天的写法：今年的不写年份，别的年份写上（侧栏项目对话分组也用这一份） */
export function dayLabel(d: Date, now = new Date(), loc = uiLocale()) {
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(loc, { ...(sameYear ? {} : { year: 'numeric' as const }), month: 'long', day: 'numeric' })
}
