import { dayLabel } from '@shared/day-groups'
import { t } from '@shared/i18n'

/**
 * 项目对话列表按「今天 / 前两天各一天 / 更早」分组：最近三天每天一组，行里只写时分；
 * 只有今天写「今天」，前两天写具体日期（用户要求：「昨天」「前天」要换算才知道是哪天）；
 * 再早的对话不再一天一组（项目里旧对话很多，一天一组会排出一长串日期），统一收进「更早」。
 * list 已经按最近发言排好，分组后组内顺序不变；没有对话的组不列。
 * now 只有测试会传，正常用当前时间
 */
export function projectDayBuckets<T>(list: T[], at: (x: T) => string, now = new Date()) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = day(now)
  const ago = (n: number) => dayLabel(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n), now)
  const buckets = [
    { key: 'today', label: t('今天'), recent: true, items: [] as T[] },
    { key: 'yesterday', label: ago(1), recent: true, items: [] as T[] },
    { key: 'dayBefore', label: ago(2), recent: true, items: [] as T[] },
    { key: 'older', label: t('更早'), recent: false, items: [] as T[] },
  ]
  for (const x of list) {
    // 跨夏令时的那天相差 23 / 25 小时，取整；时钟往回拨导致的「未来」时间算今天
    const diff = Math.round((today - day(new Date(at(x)))) / 86400000)
    buckets[Math.min(Math.max(diff, 0), 3)].items.push(x)
  }
  return buckets.filter((b) => b.items.length)
}
