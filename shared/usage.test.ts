import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task, TaskTurn } from './schema.ts'
import {
  aggregateUsage,
  dayKey,
  formatTokens,
  isoWeek,
  periodLabel,
  sumBuckets,
  usageLabel,
  usagePeriod,
  usageSamples,
  type UsageGrain,
  type UsageReport,
} from './usage.ts'

/** 固定的「现在」：本地时间 2026-10-20（周二）10:00，所在周从 10 月 19 日（周一）起 */
const now = new Date(2026, 9, 20, 10, 0, 0)

/** 一轮执行：开始时间用本地时间给，Token 按这一轮自己的数字 */
const turn = (startedAt: Date, inputTokens: number, outputTokens: number, cacheReadTokens = 0, endedAt?: Date) =>
  ({
    id: String(startedAt.getTime()),
    title: '',
    agentId: '',
    status: 'done',
    startedAt: startedAt.toISOString(),
    endedAt: (endedAt ?? startedAt).toISOString(),
    from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
    inputTokens,
    outputTokens,
    cacheReadTokens,
    waitMs: 0,
  }) as TaskTurn

/** 任务：turns 是逐轮明细，usage 是累计值（含没有逐轮记录的费用和缓存写入） */
const task = (id: string, turns: TaskTurn[], usage: Partial<Task['usage']> = {}) =>
  ({
    id,
    turns,
    usage: {
      agents: {},
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      ...usage,
    },
  }) as Pick<Task, 'id' | 'turns' | 'usage'>

const keys = (r: UsageReport) => r.buckets.map((b) => b.key)
const at = (grain: UsageGrain, count: number, tasks: Pick<Task, 'id' | 'turns' | 'usage'>[] = []) =>
  aggregateUsage(tasks.flatMap(usageSamples), { grain, count }, now)

test('没有数据：桶照样按范围列出来，都是 0，合计也是 0', () => {
  const r = at('day', 3)
  assert.deepEqual(keys(r), ['2026-10-20', '2026-10-19', '2026-10-18'])
  assert.deepEqual(
    r.buckets.map((b) => [
      b.inputTokens,
      b.outputTokens,
      b.cacheReadTokens,
      b.cacheWriteTokens,
      b.costUsd,
      b.turns,
      b.tasks,
    ]),
    [
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
    ],
  )
  assert.deepEqual(r.total, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
    tasks: 0,
    peak: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    offPeak: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })
  // 统计范围：从第一天的零点到当前桶的下一天零点
  assert.equal(new Date(r.from).getDate(), 18)
  assert.equal(new Date(r.to).getDate(), 21)
})

test('按天：跨天的一轮算在它开始的那一天', () => {
  const night = task('a', [turn(new Date(2026, 9, 19, 23, 50), 100, 20, 40, new Date(2026, 9, 20, 0, 20))])
  const r = at('day', 3, [night])
  assert.deepEqual(keys(r), ['2026-10-20', '2026-10-19', '2026-10-18'])
  // 开始于 19 日 23:50，结束在 20 日 0:20：整轮算 19 日
  assert.equal(r.buckets[1].inputTokens, 100)
  assert.equal(r.buckets[1].outputTokens, 20)
  assert.equal(r.buckets[1].turns, 1)
  assert.equal(r.buckets[0].turns, 0)
})

test('本地时区：按本机本地时间归桶，不是 UTC 日期', () => {
  const late = task('a', [turn(new Date(2026, 9, 19, 23, 30), 10, 1)])
  const early = task('b', [turn(new Date(2026, 9, 20, 0, 30), 20, 2)])
  const r = at('day', 3, [late, early])
  const of = (k: string) => r.buckets.find((b) => b.key === k)!
  assert.equal(of('2026-10-19').inputTokens, 10)
  assert.equal(of('2026-10-20').inputTokens, 20)
  // 本地时间是哪天就是哪天：和样本 ISO 字符串里的 UTC 日期无关
  assert.equal(new Date(of('2026-10-20').start).getDate(), 20)
  assert.equal(new Date(of('2026-10-20').start).getHours(), 0)
  assert.equal(of('2026-10-18').inputTokens, 0)
})

test('按周：周一为一周的第一天，周日算上一周', () => {
  const sunday = task('a', [turn(new Date(2026, 9, 18, 12, 0), 5, 1)])
  const monday = task('b', [turn(new Date(2026, 9, 19, 12, 0), 7, 2)])
  const r = at('week', 2, [sunday, monday])
  // 10 月 20 日是周二，本周从 10 月 19 日（周一）起；10 月 18 日是周日，属于上一周（10 月 12 日起）
  assert.deepEqual(keys(r), ['2026-10-19', '2026-10-12'])
  assert.equal(r.buckets[0].inputTokens, 7)
  assert.equal(r.buckets[1].inputTokens, 5)
  assert.equal(new Date(r.buckets[0].start).getDay(), 1)
})

test('按月：按自然月分桶，从新到旧', () => {
  const r = at('month', 3)
  assert.deepEqual(keys(r), ['2026-10', '2026-09', '2026-08'])
  assert.equal(new Date(r.from).getMonth(), 7)
  assert.equal(new Date(r.to).getMonth(), 10)
})

test('费用和缓存写入按各轮 token 占比分摊，加起来正好等于任务累计', () => {
  const one = task('a', [turn(new Date(2026, 9, 20, 9, 0), 100, 0), turn(new Date(2026, 9, 20, 10, 0), 200, 100)], {
    costUsd: 0.3,
    cacheWriteTokens: 100,
  })
  const samples = usageSamples(one)
  assert.equal(samples.length, 2)
  // 两轮权重 100 : 300
  assert.equal(samples[0].cacheWriteTokens, 25)
  assert.equal(samples[1].cacheWriteTokens, 75)
  assert.ok(Math.abs(samples[0].costUsd + samples[1].costUsd - 0.3) < 1e-9)
  // 余数落在最后一轮，不分摊出零头
  assert.equal(samples[1].cacheWriteTokens, 100 - samples[0].cacheWriteTokens)
})

test('均分的缓存写入不会摊出负数', () => {
  const even = task(
    'a',
    [
      turn(new Date(2026, 9, 20, 9, 0), 10, 0),
      turn(new Date(2026, 9, 20, 10, 0), 10, 0),
      turn(new Date(2026, 9, 20, 11, 0), 10, 0),
      turn(new Date(2026, 9, 20, 12, 0), 10, 0),
    ],
    { cacheWriteTokens: 2 },
  )
  const writes = usageSamples(even).map((s) => s.cacheWriteTokens)
  assert.ok(writes.every((w) => w >= 0))
  assert.equal(
    writes.reduce((n, w) => n + w, 0),
    2,
  )
})

test('没有 turns 的旧任务不计入，也不崩', () => {
  const empty = at('day', 2, [task('old', [])])
  assert.equal(empty.total.turns, 0)
  assert.equal(empty.total.inputTokens, 0)
})

test('轮次里 token 全是 0：照样算一轮，但不摊费用和缓存写入', () => {
  const zero = task('a', [turn(new Date(2026, 9, 20, 9, 0), 0, 0)], { costUsd: 0.5, cacheWriteTokens: 10 })
  const r = at('day', 2, [zero])
  assert.equal(r.buckets[0].turns, 1)
  assert.equal(r.buckets[0].tasks, 1)
  assert.equal(r.buckets[0].costUsd, 0)
  assert.equal(r.buckets[0].cacheWriteTokens, 0)
})

test('合计等于各桶之和，任务数按桶去重，轮数按轮数', () => {
  const same = task('a', [
    turn(new Date(2026, 9, 20, 9, 0), 10, 1, 3),
    turn(new Date(2026, 9, 20, 11, 0), 20, 2, 5),
    turn(new Date(2026, 9, 19, 11, 0), 30, 3, 7),
  ])
  const other = task('b', [turn(new Date(2026, 9, 19, 12, 0), 40, 4, 9)])
  const r = at('day', 2, [same, other])
  const sum = (pick: (b: UsageReport['buckets'][number]) => number) => r.buckets.reduce((n, b) => n + pick(b), 0)
  assert.deepEqual(
    r.buckets.map((b) => [b.turns, b.tasks]),
    [
      [2, 1],
      [2, 2],
    ],
  )
  assert.equal(
    r.total.inputTokens,
    sum((b) => b.inputTokens),
  )
  assert.equal(
    r.total.outputTokens,
    sum((b) => b.outputTokens),
  )
  assert.equal(
    r.total.cacheReadTokens,
    sum((b) => b.cacheReadTokens),
  )
  assert.equal(
    r.total.cacheWriteTokens,
    sum((b) => b.cacheWriteTokens),
  )
  assert.equal(
    r.total.costUsd,
    sum((b) => b.costUsd),
  )
  assert.equal(
    r.total.turns,
    sum((b) => b.turns),
  )
  assert.equal(
    r.total.tasks,
    sum((b) => b.tasks),
  )
  assert.equal(r.total.inputTokens, 100)
  assert.equal(r.total.cacheReadTokens, 24)
})

test('窗口外的样本丢掉，参数认不出来时用默认值', () => {
  const old = task('a', [turn(new Date(2026, 8, 1, 9, 0), 99, 9)])
  const r = aggregateUsage(usageSamples(old), { grain: 'day', count: Number.NaN }, now)
  assert.equal(r.buckets.length, 14)
  assert.equal(r.total.inputTokens, 0)
  const bad = aggregateUsage([], { grain: 'week', count: 1e9 }, now)
  assert.equal(bad.buckets.length, 366)
})

test('桶的标签按粒度写', () => {
  const report = at('month', 1)
  assert.match(usageLabel(report.buckets[0], 'month'), /2026.*10/)
  assert.match(usageLabel(at('day', 1).buckets[0], 'day'), /10.*20/)
})

const dates = (p: ReturnType<typeof usagePeriod>) => p.days.map(dayKey)

/** 一段日期：本地时间，测试不依赖时区 */
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d)

test('区间：天是一天，周是周一到周日，月是整个自然月', () => {
  // 2026-10-20 是周二
  assert.deepEqual(dates(usagePeriod('day', local(2026, 10, 20))), ['2026-10-20'])
  const week = usagePeriod('week', local(2026, 10, 20))
  assert.deepEqual(dates(week), [
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
  ])
  // 周日算在上一周里
  assert.equal(dayKey(usagePeriod('week', local(2026, 10, 25)).start), '2026-10-19')
  assert.equal(usagePeriod('month', local(2026, 2, 15)).days.length, 28)
  assert.equal(usagePeriod('month', local(2028, 2, 1)).days.length, 29)
  assert.equal(dayKey(usagePeriod('month', local(2026, 12, 31)).end), '2026-12-31')
})

test('区间标签：周写第几周和起止日期', () => {
  assert.equal(periodLabel(usagePeriod('day', local(2026, 10, 23))), '10月23日')
  assert.equal(periodLabel(usagePeriod('month', local(2026, 10, 23))), '2026年10月')
  assert.equal(periodLabel(usagePeriod('week', local(2026, 10, 20))), '第 43 周 · 10月19日 - 10月25日')
  // 跨年的那一周按 ISO 的归属算周号：2024-12-30 属于 2025 年第 1 周
  assert.deepEqual(isoWeek(local(2024, 12, 30)), { year: 2025, week: 1 })
  // 2021-01-01 是周五，属于 2020 年第 53 周
  assert.deepEqual(isoWeek(local(2021, 1, 1)), { year: 2020, week: 53 })
})

test('token 短格式：K / M 两位小数，0 就是 0', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1500), '1.5K')
  assert.equal(formatTokens(3_328_101), '3.33M')
  assert.equal(formatTokens(727_366_264), '727.37M')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatTokens(Number.NaN), '0')
})

test('几个桶相加和接口给的合计是同一个算法', () => {
  const r = at('day', 3, [task('a', [turn(new Date(2026, 9, 19, 9, 0), 10, 2, 3)])])
  assert.deepEqual(sumBuckets(r.buckets), r.total)
})

/** 北京时间 → 带 Z 的 UTC 字符串：峰谷测试不能随本机时区变 */
const bj = (day: string, hhmm: string) => {
  const [y, mo, d] = day.split('-').map(Number)
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h - 8, m)).toISOString()
}

/** 366 天窗口里的合计：不依赖样本落到哪个本地日期 */
const sumOf = (r: UsageReport, pick: (b: UsageReport['buckets'][number]) => number) =>
  r.buckets.reduce((n, b) => n + pick(b), 0)

/** 2026-10-26（周一）北京时间中午：366 天窗口盖住下面用的几天 */
const peakNow = new Date(bj('2026-10-26', '12:00:00'))

const daily = (tasks: Pick<Task, 'id' | 'turns' | 'usage'>[]) =>
  aggregateUsage(tasks.flatMap(usageSamples), { grain: 'day', count: 366 }, peakNow)

test('峰谷：按每轮开始的时间拆成两组，两组加起来正好是总量', () => {
  // 2026-10-23 是周五：北京 10:00 是高峰，13:00 午休和周六 10:00 都是空闲
  const peak = task('a', [turn(new Date(bj('2026-10-23', '10:00:00')), 100, 10, 40)])
  const noon = task('b', [turn(new Date(bj('2026-10-23', '13:00:00')), 200, 20, 80)])
  const weekend = task('c', [turn(new Date(bj('2026-10-24', '10:00:00')), 300, 30, 120)])
  const r = daily([peak, noon, weekend])
  assert.equal(
    sumOf(r, (b) => b.peak.inputTokens),
    100,
  )
  assert.equal(
    sumOf(r, (b) => b.offPeak.inputTokens),
    500,
  )
  assert.equal(
    sumOf(r, (b) => b.peak.outputTokens),
    10,
  )
  assert.equal(
    sumOf(r, (b) => b.offPeak.outputTokens),
    50,
  )
  assert.equal(
    sumOf(r, (b) => b.peak.cacheReadTokens),
    40,
  )
  assert.equal(
    sumOf(r, (b) => b.offPeak.cacheReadTokens),
    200,
  )
  // 每一桶都守恒：两组之和等于总量，不会因为拆分多出或漏掉 token
  for (const b of r.buckets) {
    assert.equal(b.peak.inputTokens + b.offPeak.inputTokens, b.inputTokens, `${b.key} 输入不守恒`)
    assert.equal(b.peak.outputTokens + b.offPeak.outputTokens, b.outputTokens, `${b.key} 输出不守恒`)
    assert.equal(b.peak.cacheReadTokens + b.offPeak.cacheReadTokens, b.cacheReadTokens, `${b.key} 缓存命中不守恒`)
    assert.equal(b.peak.cacheWriteTokens + b.offPeak.cacheWriteTokens, b.cacheWriteTokens, `${b.key} 缓存写入不守恒`)
  }
  // 几个桶相加时两组都累加，合计也能按峰谷分别计价
  const all = sumBuckets(r.buckets)
  assert.equal(all.peak.inputTokens, 100)
  assert.equal(all.offPeak.inputTokens, 500)
  assert.deepEqual(all, r.total)
})

test('峰谷：缓存写入按轮分摊后跟着那一轮归到各自的档', () => {
  // 两轮权重 100 : 300，缓存写入 100 → 25 / 75
  const one = task(
    'a',
    [turn(new Date(bj('2026-10-23', '10:00:00')), 100, 0), turn(new Date(bj('2026-10-23', '13:00:00')), 200, 100)],
    { cacheWriteTokens: 100 },
  )
  const r = daily([one])
  assert.equal(
    sumOf(r, (b) => b.peak.cacheWriteTokens),
    25,
  )
  assert.equal(
    sumOf(r, (b) => b.offPeak.cacheWriteTokens),
    75,
  )
  assert.equal(
    sumOf(r, (b) => b.cacheWriteTokens),
    100,
  )
})

test('峰谷：轮次里 token 全为 0 也按开始时间归到高峰或空闲', () => {
  const empty = task('a', [turn(new Date(bj('2026-10-23', '10:00:00')), 0, 0)])
  const r = daily([empty])
  // 高峰、空闲两组的 token 都是 0，但轮数算在这一桶里，峰谷明细不会互相抵消
  assert.equal(r.total.turns, 1)
  assert.equal(
    sumOf(r, (b) => b.peak.inputTokens),
    0,
  )
  assert.equal(
    sumOf(r, (b) => b.offPeak.inputTokens),
    0,
  )
})
