import { t } from './i18n.ts'
import { pad2, ymd } from './datetime.ts'
import type { Task } from './schema.ts'

/**
 * 用量统计：把每个任务各轮执行（`Task.turns`）的 token 按本地时间归到天 / 周 / 月，聚合成表格。
 *
 * 为什么从 turns 聚合：`Task.usage` 只有累计值、没有时间，`Task.turns` 是唯一带时间戳的用量明细。
 * 归桶规则（`shared/usage.test.ts` 覆盖了这几条）：
 * - 一轮归到它**开始时间**（`startedAt`）所在的桶：23:50 开始、第二天 0:20 结束的一轮算在开始那天。
 * - 周从周一起算，月按自然月；时区一律用本机本地时间（和任务列表按天分组一致）。
 * - 费用和缓存写入没有逐轮记录，按各轮 token 占比从任务累计里分摊，最后一份取余数，
 *   加起来正好等于任务累计。
 * - 任务没有 turns、或者轮次里一个 token 都没有时，对不上时间就不计入（不凭空摊到某一天）。
 */

/** 统计粒度；count 是这个粒度下默认看多少个桶（天看近两周，周和月看近一年） */
export const USAGE_GRAINS = [
  { id: 'day', label: t('按天'), count: 14 },
  { id: 'week', label: t('按周'), count: 12 },
  { id: 'month', label: t('按月'), count: 12 },
] as const
export type UsageGrain = (typeof USAGE_GRAINS)[number]['id']

/** 一个粒度的默认桶数 */
export function usageCount(grain: UsageGrain) {
  return USAGE_GRAINS.find((g) => g.id === grain)?.count ?? 14
}

/**
 * 用量页一次取近一年的按天数据（366 天，含闰年），周和月在它的范围里翻。
 * 三个视图都用这一份按天数据：切粒度不用重新请求，合计按天相加（口径和接口给的合计一致）。
 */
export const USAGE_LOOKBACK_DAYS = 366

/** 一次查询：哪个粒度、看多少个桶（含当前这个桶，往前数）；参数来自 URL，认不出来时用默认值 */
export const UsageQuery = {
  grain: (g: unknown): UsageGrain => (USAGE_GRAINS.some((x) => x.id === g) ? (g as UsageGrain) : 'day'),
  count: (n: unknown, grain: UsageGrain): number => {
    const v = Math.floor(Number(n))
    return Number.isFinite(v) && v > 0 ? Math.min(v, 366) : usageCount(grain)
  },
}

/** 一条按时间归桶的用量：一轮执行分摊后的数字 */
export type UsageSample = {
  taskId: string
  /** 这一轮的开始时间（ISO），按它的本地日期归桶 */
  at: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

/**
 * 四项 token：输入含缓存命中和缓存写入（和 Task.usage 的口径一致）。
 * 单独成一个类型，是因为分时段计价要把同一批数字按峰 / 谷拆成两份。
 */
export type TokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * 分时段定价的时段定义：`ranges` 里算高峰，其余时段（含周末、法定节假日）算空闲 / 优惠。
 * 判定用 `timeZone` 的当地钟点，不用本机时区：本机可能不是用户付费所在时区，按本机算会把峰谷算反。
 * 详情和价格来源见 `shared/pricing.ts` 的注释。
 */
export type PeakWindow = {
  /** IANA 时区，按它的当地钟点判定 */
  timeZone: string
  /** 高峰时段的钟点范围（当地时间的 HH:MM，左闭右开），上午、下午各一段时可以给多段 */
  ranges: ReadonlyArray<{ start: string; end: string }>
  /** 只有这几天算高峰（0 = 周日 … 6 = 周六）；不填表示每天都一样 */
  weekdays?: ReadonlyArray<number>
  /** 全天算空闲的当地日期（YYYY-MM-DD）：法定节假日 */
  holidays?: ReadonlyArray<string>
}

/**
 * DeepSeek 官方的时段规则：北京时间周一至周五 9:00-12:00、14:00-18:00 是高峰，其余是空闲。
 * 官方定价页（2026-10-23 抓取）原文：「空闲时段价格为高峰时段价格的一半。北京时间周一至周五
 * （不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国
 * 法定节假日全天均为空闲时段。」来源 URL 见 `shared/pricing.ts`。
 *
 * 法定节假日没有内置表（每年国务院公布一次，写死会过期）：节假日按高峰算，价格更高，不会低估费用。
 */
export const DEEPSEEK_PEAK_WINDOW: PeakWindow = {
  timeZone: 'Asia/Shanghai',
  ranges: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  weekdays: [1, 2, 3, 4, 5],
}

/** 一个桶（一天 / 一周 / 一个月） */
export type UsageBucket = TokenTotals & {
  /** 桶的标识：天和周是桶第一天的日期 2026-10-20，月是 2026-10 */
  key: string
  /** 桶的第一天（本地时间的零点，ISO）；前端用它格式化标签 */
  start: string
  costUsd: number
  /** 这一桶里有几轮执行 */
  turns: number
  /** 这一桶里有几轮不同的任务 */
  tasks: number
  /** 落在高峰时段的那部分，已经包含在上面四项里，不另外相加 */
  peak: TokenTotals
  /** 落在空闲（优惠）时段的那部分，已经包含在上面四项里，不另外相加 */
  offPeak: TokenTotals
}

export type UsageTotal = Omit<UsageBucket, 'key' | 'start'>

export type UsageReport = {
  grain: UsageGrain
  /** 统计范围的第一天（含）和最后一天的次日（不含），本地时间 */
  from: string
  to: string
  /** 从新到旧：第一个是当前这个桶 */
  buckets: UsageBucket[]
  /** 所有桶的和（逐桶累加得到，一定等于各桶之和） */
  total: UsageTotal
}

const num = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)

const noTokens = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

/** 本地时间的零点 */
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** 这一周的周一（本地时间零点）：周日是一周的最后一天 */
const weekStart = (d: Date) => {
  const x = midnight(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

/** 桶的第一天：天是今天，周是本周周一，月是本月一号 */
export function periodStart(grain: UsageGrain, d: Date) {
  return grain === 'day' ? midnight(d) : grain === 'week' ? weekStart(d) : new Date(d.getFullYear(), d.getMonth(), 1)
}

/**
 * 这一段是不是「当前」：按天是今天、按周是本周、按月是本月。
 * 传区间里任意一天都行（先归一化到区间第一天再比），工具条用它决定要不要出「重置」按钮：
 * 已经在当前区间时没东西可重置。
 */
export function isCurrentPeriod(grain: UsageGrain, day: Date, now: Date = new Date()) {
  return periodStart(grain, day).getTime() === periodStart(grain, now).getTime()
}

/** 从某个桶往前数 n 个桶 */
export function shiftPeriod(grain: UsageGrain, start: Date, n: number) {
  if (grain === 'day') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + n)
  if (grain === 'week') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + n * 7)
  return new Date(start.getFullYear(), start.getMonth() + n, 1)
}

/** 本地日期标识：2026-10-23（和桶的 key 同格式，按天视图直接比） */
export const dayKey = ymd

/**
 * ISO 周号：周一开头，含 1 月 4 日的那一周是第 1 周。
 * 先挪到本周的周四，再用它所在的年和那一年的第一个周四算，跨年时也按 ISO 的归属走。
 */
export function isoWeek(d: Date) {
  const target = midnight(d)
  target.setDate(target.getDate() - ((target.getDay() + 6) % 7) + 3)
  const year = target.getFullYear()
  const first = new Date(year, 0, 4)
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7) + 3)
  return { year, week: 1 + Math.round((target.getTime() - first.getTime()) / (7 * 86_400_000)) }
}

/** 一个视图的时间范围：天是 1 天，周是周一到周日，月是整个自然月 */
export type UsagePeriod = {
  grain: UsageGrain
  /** 区间第一天（本地零点） */
  start: Date
  /** 区间最后一天（本地零点，含这一天） */
  end: Date
  /** 区间里的每一天，从 start 排到 end */
  days: Date[]
}

/** 某一天落在哪个区间里；周从周一起算 */
export function usagePeriod(grain: UsageGrain, day: Date): UsagePeriod {
  const start = periodStart(grain, day)
  const end = grain === 'day' ? start : shiftPeriod(grain, start, 1)
  if (grain !== 'day') end.setDate(end.getDate() - 1)
  const days: Date[] = []
  for (let d = midnight(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d)
  return { grain, start, end, days }
}

/**
 * 区间的标签：10月23日 / 第 43 周 · 10月19日 - 10月25日 / 2026年10月。
 * 周带上第几周，按月切换、跟人说话时都对得上号。
 */
export function periodLabel(period: UsagePeriod) {
  const { grain, start, end } = period
  if (grain === 'month') return usageLabel({ start: start.toISOString() }, 'month')
  const head = usageLabel({ start: start.toISOString() }, 'day')
  if (grain === 'day') return head
  const tail = usageLabel({ start: end.toISOString() }, 'day')
  return t('第 {n} 周 · {from} - {to}', { n: isoWeek(start).week, from: head, to: tail })
}

/**
 * token 的短格式：727366264 → 727.37M、3328101 → 3.33M、0 → 0。
 * 表格和合计都用它，精确原值放在 title 里；两位小数去掉多余的 0（1.00M 显示 1M）。
 */
export function formatTokens(n: number) {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  if (v < 1000) return String(Math.round(v))
  const [num, unit] = v < 1_000_000 ? [v / 1000, 'K'] : [v / 1_000_000, 'M']
  return `${+num.toFixed(2)}${unit}`
}

function keyOf(grain: UsageGrain, start: Date) {
  const y = start.getFullYear()
  const m = pad2(start.getMonth() + 1)
  return grain === 'month' ? `${y}-${m}` : `${y}-${m}-${pad2(start.getDate())}`
}

/** 桶的标签：10月20日 / 10月20日这一周 / 2026年10月 */
export function usageLabel(bucket: Pick<UsageBucket, 'start'>, grain: UsageGrain) {
  const d = new Date(bucket.start)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  if (grain === 'month') return t('{y}年{m}月', { y, m })
  if (grain === 'week') return t('{m}月{d}日这一周', { m, d: day })
  return t('{m}月{d}日', { m, d: day })
}

/**
 * 一个任务拆成按时间归桶的样本：每轮一条。
 * 旧任务没有 turns 时返回空（对不上时间，整条不计入）；轮次里 token 为 0 的照样算一轮。
 */
export function usageSamples(task: Pick<Task, 'id' | 'turns' | 'usage'>): UsageSample[] {
  const turns = (task.turns ?? []).filter((x) => x.startedAt && !Number.isNaN(Date.parse(x.startedAt)))
  if (!turns.length) return []
  const weights = turns.map((x) => num(x.inputTokens) + num(x.outputTokens))
  const whole = weights.reduce((n, w) => n + w, 0)
  // 轮次里一个 token 都没有：费用和缓存写入对不上时间，不摊（不凭空造数）
  const parts = whole > 0 ? weights.map((w) => w / whole) : weights.map(() => 0)
  let spentCost = 0
  let spentWrite = 0
  return turns.map((x, i) => {
    const last = i === turns.length - 1
    // 最后一份取余数：分摊下来加起来正好是任务累计，不会多出或漏掉零头
    const write =
      whole > 0
        ? last
          ? Math.max(0, num(task.usage?.cacheWriteTokens) - spentWrite)
          : Math.floor(num(task.usage?.cacheWriteTokens) * parts[i])
        : 0
    const cost = whole > 0 ? (last ? num(task.usage?.costUsd) - spentCost : num(task.usage?.costUsd) * parts[i]) : 0
    spentWrite += write
    spentCost += cost
    return {
      taskId: task.id,
      at: x.startedAt,
      inputTokens: num(x.inputTokens),
      outputTokens: num(x.outputTokens),
      cacheReadTokens: num(x.cacheReadTokens),
      cacheWriteTokens: write,
      costUsd: cost,
    }
  })
}

const emptyBucket = (grain: UsageGrain, start: Date): UsageBucket => ({
  key: keyOf(grain, start),
  start: start.toISOString(),
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  turns: 0,
  tasks: 0,
  peak: noTokens(),
  offPeak: noTokens(),
})

/** HH:MM → 当天的分钟数 */
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** 按指定时区取当地钟点的格式化器（每个时区建一次，表格每行都要判定） */
const clockFormats = new Map<string, Intl.DateTimeFormat>()
function clockFormat(timeZone: string) {
  let f = clockFormats.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    clockFormats.set(timeZone, f)
  }
  return f
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * 这一轮开始时间落在不在高峰时段：按 `window.timeZone` 的当地钟点算，和本机时区无关。
 * 时间认不出来时算高峰（价格更高，不会低估费用）；落在时段边界上按左闭右开处理（09:00 算高峰、12:00 算空闲）。
 */
export function inPeak(at: string | Date, window: PeakWindow = DEEPSEEK_PEAK_WINDOW): boolean {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return true
  const parts: Record<string, string> = {}
  for (const p of clockFormat(window.timeZone).formatToParts(d)) parts[p.type] = p.value
  if (window.holidays?.includes(`${parts.year}-${parts.month}-${parts.day}`)) return false
  if (window.weekdays && !window.weekdays.includes(WEEKDAY_INDEX[parts.weekday])) return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return window.ranges.some((r) => minutes >= toMinutes(r.start) && minutes < toMinutes(r.end))
}

/**
 * 把样本聚合成 `count` 个桶（含当前这个桶，往前数），从新到旧排。
 * 窗口外的样本丢掉；同一个桶里的任务数按去重后的 taskId 算。
 */
export function aggregateUsage(
  samples: UsageSample[],
  query: { grain: UsageGrain; count: number },
  now: Date = new Date(),
  /** 判定峰谷用的时段定义；接口固定用官方那一套 */
  peakWindow: PeakWindow = DEEPSEEK_PEAK_WINDOW,
): UsageReport {
  const grain = UsageQuery.grain(query.grain)
  const count = UsageQuery.count(query.count, grain)
  const latest = periodStart(grain, now)
  const buckets: UsageBucket[] = []
  const index = new Map<string, UsageBucket>()
  for (let i = 0; i < count; i++) {
    const b = emptyBucket(grain, shiftPeriod(grain, latest, -i))
    buckets.push(b)
    index.set(b.key, b)
  }
  const seen = new Map<UsageBucket, Set<string>>()
  for (const s of samples) {
    const at = new Date(s.at)
    if (Number.isNaN(at.getTime())) continue
    const b = index.get(keyOf(grain, periodStart(grain, at)))
    if (!b) continue
    b.inputTokens += num(s.inputTokens)
    b.outputTokens += num(s.outputTokens)
    b.cacheReadTokens += num(s.cacheReadTokens)
    b.cacheWriteTokens += num(s.cacheWriteTokens)
    b.costUsd += num(s.costUsd)
    b.turns += 1
    // 峰谷按「这一轮开始的时间」判定，再各记一份，两份加起来等于上面的总量
    const tier = inPeak(at, peakWindow) ? b.peak : b.offPeak
    tier.inputTokens += num(s.inputTokens)
    tier.outputTokens += num(s.outputTokens)
    tier.cacheReadTokens += num(s.cacheReadTokens)
    tier.cacheWriteTokens += num(s.cacheWriteTokens)
    let ids = seen.get(b)
    if (!ids) seen.set(b, (ids = new Set()))
    ids.add(s.taskId)
  }
  for (const [b, ids] of seen) b.tasks = ids.size
  return {
    grain,
    from: shiftPeriod(grain, latest, -(count - 1)).toISOString(),
    to: shiftPeriod(grain, latest, 1).toISOString(),
    buckets,
    total: sumBuckets(buckets),
  }
}

/**
 * 几个桶相加：只选了一个区间时（按天一天、按周一周、按月一月）用它算合计。
 * 任务数按各桶去重后再加（和接口给的合计同一个算法），跨桶的同一个任务会分别算进各自的桶。
 */
export function sumBuckets(buckets: UsageBucket[]): UsageTotal {
  const total: UsageTotal = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
    tasks: 0,
    peak: noTokens(),
    offPeak: noTokens(),
  }
  for (const b of buckets) {
    total.inputTokens += b.inputTokens
    total.outputTokens += b.outputTokens
    total.cacheReadTokens += b.cacheReadTokens
    total.cacheWriteTokens += b.cacheWriteTokens
    total.costUsd += b.costUsd
    total.turns += b.turns
    total.tasks += b.tasks
    for (const tier of ['peak', 'offPeak'] as const) {
      total[tier].inputTokens += b[tier].inputTokens
      total[tier].outputTokens += b[tier].outputTokens
      total[tier].cacheReadTokens += b[tier].cacheReadTokens
      total[tier].cacheWriteTokens += b[tier].cacheWriteTokens
    }
  }
  return total
}

/** 任务列表 → 样本 → 报表，服务端一次调用就够 */
export function usageReport(
  tasks: Task[],
  query: { grain: UsageGrain; count: number },
  now: Date = new Date(),
  peakWindow: PeakWindow = DEEPSEEK_PEAK_WINDOW,
) {
  return aggregateUsage(tasks.flatMap(usageSamples), query, now, peakWindow)
}
