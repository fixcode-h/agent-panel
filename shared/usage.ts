import { t } from './i18n.ts'
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

/** 一个桶（一天 / 一周 / 一个月） */
export type UsageBucket = {
  /** 桶的标识：天和周是桶第一天的日期 2026-10-20，月是 2026-10 */
  key: string
  /** 桶的第一天（本地时间的零点，ISO）；前端用它格式化标签 */
  start: string
  /** 输入（含缓存命中和写入的部分，和 Task.usage 的定义一致） */
  inputTokens: number
  outputTokens: number
  /** 输入里命中缓存的部分，是 inputTokens 的一部分，不另外相加 */
  cacheReadTokens: number
  /** 输入里写入缓存的部分，是 inputTokens 的一部分，不另外相加 */
  cacheWriteTokens: number
  costUsd: number
  /** 这一桶里有几轮执行 */
  turns: number
  /** 这一桶里有几轮不同的任务 */
  tasks: number
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

/** 本地时间的零点 */
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** 这一周的周一（本地时间零点）：周日是一周的最后一天 */
const weekStart = (d: Date) => {
  const x = midnight(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

/** 桶的第一天：天是今天，周是本周周一，月是本月一号 */
function bucketStart(grain: UsageGrain, d: Date) {
  return grain === 'day' ? midnight(d) : grain === 'week' ? weekStart(d) : new Date(d.getFullYear(), d.getMonth(), 1)
}

/** 从某个桶往前数 n 个桶 */
function shift(grain: UsageGrain, start: Date, n: number) {
  if (grain === 'day') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + n)
  if (grain === 'week') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + n * 7)
  return new Date(start.getFullYear(), start.getMonth() + n, 1)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 桶的标识：天和周到日，月到月 */
function keyOf(grain: UsageGrain, start: Date) {
  const y = start.getFullYear()
  const m = pad(start.getMonth() + 1)
  return grain === 'month' ? `${y}-${m}` : `${y}-${m}-${pad(start.getDate())}`
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
})

/**
 * 把样本聚合成 `count` 个桶（含当前这个桶，往前数），从新到旧排。
 * 窗口外的样本丢掉；同一个桶里的任务数按去重后的 taskId 算。
 */
export function aggregateUsage(
  samples: UsageSample[],
  query: { grain: UsageGrain; count: number },
  now: Date = new Date(),
): UsageReport {
  const grain = UsageQuery.grain(query.grain)
  const count = UsageQuery.count(query.count, grain)
  const latest = bucketStart(grain, now)
  const buckets: UsageBucket[] = []
  const index = new Map<string, UsageBucket>()
  for (let i = 0; i < count; i++) {
    const b = emptyBucket(grain, shift(grain, latest, -i))
    buckets.push(b)
    index.set(b.key, b)
  }
  const seen = new Map<UsageBucket, Set<string>>()
  for (const s of samples) {
    const at = new Date(s.at)
    if (Number.isNaN(at.getTime())) continue
    const b = index.get(keyOf(grain, bucketStart(grain, at)))
    if (!b) continue
    b.inputTokens += num(s.inputTokens)
    b.outputTokens += num(s.outputTokens)
    b.cacheReadTokens += num(s.cacheReadTokens)
    b.cacheWriteTokens += num(s.cacheWriteTokens)
    b.costUsd += num(s.costUsd)
    b.turns += 1
    let ids = seen.get(b)
    if (!ids) seen.set(b, (ids = new Set()))
    ids.add(s.taskId)
  }
  for (const [b, ids] of seen) b.tasks = ids.size
  const total: UsageTotal = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
    tasks: 0,
  }
  for (const b of buckets) {
    total.inputTokens += b.inputTokens
    total.outputTokens += b.outputTokens
    total.cacheReadTokens += b.cacheReadTokens
    total.cacheWriteTokens += b.cacheWriteTokens
    total.costUsd += b.costUsd
    total.turns += b.turns
    // 合计里的任务数是各桶去重后再加：同一个任务跨桶会分别算进各自的桶
    total.tasks += b.tasks
  }
  return {
    grain,
    from: shift(grain, latest, -(count - 1)).toISOString(),
    to: shift(grain, latest, 1).toISOString(),
    buckets,
    total,
  }
}

/** 任务列表 → 样本 → 报表，服务端一次调用就够 */
export function usageReport(tasks: Task[], query: { grain: UsageGrain; count: number }, now: Date = new Date()) {
  return aggregateUsage(tasks.flatMap(usageSamples), query, now)
}
