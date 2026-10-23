import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PRICING_MODEL,
  PRICING_MODELS,
  formatMoney,
  pricingModel,
  tierCost,
  usageCost,
  usageCostOf,
  type PricingModel,
} from './pricing.ts'
import { DEEPSEEK_PEAK_WINDOW, inPeak } from './usage.ts'

/** 计价用的 token：只填要算的那几项 */
const tokens = (
  t: Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens', number>>,
) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...t,
})

const flash = pricingModel('deepseek-flash')
const pro = pricingModel('deepseek-v4-pro')

test('单价表：默认模型是列表的第一项，两个模型的缓存写入都按未命中输入价映射', () => {
  assert.equal(DEFAULT_PRICING_MODEL, PRICING_MODELS[0].id)
  for (const m of PRICING_MODELS) {
    assert.equal(m.currency, 'CNY')
    assert.match(m.priceAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(m.source, /^https:\/\/api-docs\.deepseek\.com\//)
    // 官方没单列缓存写入价：按未命中输入价计（注释里有依据），改这两项时测试先红
    assert.equal(m.prices.cacheWrite, m.prices.inputMiss)
    // 官方分高峰、空闲两档：空闲价正好是高峰价的一半，价格表和服务端拆分用同一套时段
    assert.ok(m.offPeakPrices, `${m.id} 应该有空闲时段单价`)
    assert.deepEqual(m.window, DEEPSEEK_PEAK_WINDOW)
    for (const k of ['inputMiss', 'cacheHit', 'cacheWrite', 'output'] as const)
      assert.equal(m.offPeakPrices[k], m.prices[k] / 2, `${m.id} 的 ${k} 空闲价不是高峰价的一半`)
  }
  assert.deepEqual(flash?.prices, { inputMiss: 2, cacheHit: 0.04, cacheWrite: 2, output: 8 })
  assert.deepEqual(flash?.offPeakPrices, { inputMiss: 1, cacheHit: 0.02, cacheWrite: 1, output: 4 })
  assert.deepEqual(pro?.prices, { inputMiss: 9, cacheHit: 0.3, cacheWrite: 9, output: 27 })
  assert.deepEqual(pro?.offPeakPrices, { inputMiss: 4.5, cacheHit: 0.15, cacheWrite: 4.5, output: 13.5 })
})

test('计价：输入含缓存，先拆出命中和写入，剩下的才按未命中价算', () => {
  // 1M 全部未命中的输入 → 2 元
  assert.equal(usageCost(tokens({ inputTokens: 1_000_000 }), flash), 2)
  // 1M 全部命中缓存 → 0.04 元
  assert.equal(usageCost(tokens({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }), flash), 0.04)
  // 1M 全部写入缓存 → 按未命中价 2 元
  assert.equal(usageCost(tokens({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }), flash), 2)
  // 300k 未命中 + 400k 命中 + 300k 写入 + 500k 输出
  assert.equal(
    usageCost(
      tokens({ inputTokens: 1_000_000, cacheReadTokens: 400_000, cacheWriteTokens: 300_000, outputTokens: 500_000 }),
      flash,
    ),
    0.6 + 0.016 + 0.6 + 4,
  )
  // 高倍率模型同样按输入减缓存后的口径
  assert.equal(usageCost(tokens({ inputTokens: 1_000_000 }), pro), 9)
})

test('计价：缓存数超过输入时夹到输入以内，不会算出负数或重复收费', () => {
  assert.equal(usageCost(tokens({ inputTokens: 1000, cacheReadTokens: 5000 }), flash), (1000 * 0.04) / 1_000_000)
  assert.equal(
    usageCost(tokens({ inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 900 }), flash),
    (900 * 0.04 + 100 * 2) / 1_000_000,
  )
})

test('计价：没有配置单价的模型返回 null，不拿 0 冒充', () => {
  assert.equal(usageCost(tokens({ inputTokens: 1000 }), undefined), null)
  assert.equal(usageCostOf(tokens({ inputTokens: 1000 }), 'deepseek-chat'), null)
  assert.equal(usageCostOf(tokens({ inputTokens: 1000 }), 'deepseek-flash'), 0.002)
})

test('金额：两位小数带千分位，分以下的小额保留四位（和原来 usd() 的意图一致）', () => {
  assert.equal(formatMoney(0), '¥0.00')
  assert.equal(formatMoney(-1), '¥0.00')
  assert.equal(formatMoney(1_234.5), '¥1,234.50')
  assert.equal(formatMoney(0.05), '¥0.05')
  assert.equal(formatMoney(0.00123), '¥0.0012')
  assert.equal(formatMoney(0.00125), '¥0.0013')
  assert.equal(formatMoney(2, 'USD'), '$2.00')
})

/** 不分时段定价的模型：只有一套价，用来验证回落 */
const plain: PricingModel = {
  id: 'plain',
  label: 'Plain',
  currency: 'CNY',
  prices: { inputMiss: 1, cacheHit: 0.1, cacheWrite: 1, output: 2 },
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  priceAt: '2026-10-23',
}

const zeros = tokens({})

/** 北京时间 → 带 Z 的 UTC 字符串：测试不随本机时区变 */
const bj = (day: string, hhmm: string) => {
  const [y, mo, d] = day.split('-').map(Number)
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h - 8, m)).toISOString()
}

test('峰谷时段：官方规则的每个边界都按左闭右开判（北京时间）', () => {
  // 2026-10-23 是周五：上午 9:00-12:00、下午 14:00-18:00 是高峰
  assert.equal(inPeak(bj('2026-10-23', '08:59:59')), false, '08:59:59 还算空闲')
  assert.equal(inPeak(bj('2026-10-23', '09:00:00')), true, '09:00:00 进高峰')
  assert.equal(inPeak(bj('2026-10-23', '11:59:59')), true, '11:59:59 还在高峰')
  assert.equal(inPeak(bj('2026-10-23', '12:00:00')), false, '12:00:00 离开高峰')
  assert.equal(inPeak(bj('2026-10-23', '13:59:59')), false, '午休算空闲')
  assert.equal(inPeak(bj('2026-10-23', '14:00:00')), true, '14:00:00 进高峰')
  assert.equal(inPeak(bj('2026-10-23', '17:59:59')), true, '17:59:59 还在高峰')
  assert.equal(inPeak(bj('2026-10-23', '18:00:00')), false, '18:00:00 离开高峰')
  // 周末全天算空闲（官方：其余时段包括周末及法定节假日全天）
  assert.equal(inPeak(bj('2026-10-24', '10:00:00')), false, '周六 10:00 是空闲')
  assert.equal(inPeak(bj('2026-10-25', '10:00:00')), false, '周日 10:00 是空闲')
  assert.equal(inPeak(bj('2026-10-26', '10:00:00')), true, '周一 10:00 回到高峰')
  // 法定节假日：配了表就全天算空闲
  assert.equal(inPeak(bj('2026-10-23', '10:00:00'), { ...DEEPSEEK_PEAK_WINDOW, holidays: ['2026-10-23'] }), false)
  // 时间认不出来时按高峰算（价格更高，不会低估）
  assert.equal(inPeak('不是时间'), true)
})

test('峰谷时段：用的是时段定义里的时区，不是本机时区', () => {
  // 北京 2026-10-23 10:00 是高峰；同一时刻在纽约是 10-22 22:00，不在高峰窗口里
  const at = '2026-10-23T02:00:00Z'
  assert.equal(inPeak(at), true)
  assert.equal(inPeak(at, { ...DEEPSEEK_PEAK_WINDOW, timeZone: 'America/New_York' }), false)
  // 换成 UTC 判定也一样：03:23 不在 9-12 / 14-18 里
  assert.equal(inPeak('2026-10-23T03:23:00Z', { ...DEEPSEEK_PEAK_WINDOW, timeZone: 'UTC' }), false)
})

test('计价：分时段的模型两档分别计价后相加，合成合计时和总量口径一致', () => {
  // 高峰 1M 未命中输入 = 2 元，空闲 1M = 1 元
  const split = { peak: tokens({ inputTokens: 1_000_000 }), offPeak: tokens({ inputTokens: 1_000_000 }) }
  const total = tokens({ inputTokens: 2_000_000 })
  assert.equal(usageCost(total, flash, split), 3)
  // 同一批 token 没有拆分数据时仍按高峰价算（宁高不低）
  assert.equal(usageCost(total, flash), 4)
  // 输出、缓存命中同样各按自己那一档的价
  const mixed = {
    peak: tokens({ inputTokens: 1_000_000, cacheReadTokens: 400_000, outputTokens: 500_000 }),
    offPeak: tokens({ inputTokens: 1_000_000, cacheReadTokens: 400_000, outputTokens: 500_000 }),
  }
  const whole = tokens({ inputTokens: 2_000_000, cacheReadTokens: 800_000, outputTokens: 1_000_000 })
  // 高峰：0.6M×9 + 0.4M×0.3 + 0.5M×27 = 19.02；空闲：0.6M×4.5 + 0.4M×0.15 + 0.5M×13.5 = 9.51
  assert.ok(Math.abs((usageCost(whole, pro, mixed) ?? 0) - 28.53) < 1e-9)
})

test('计价：不支持分时段的模型回落到单一价，不凭空拆分', () => {
  const split = { peak: tokens({ inputTokens: 500_000 }), offPeak: tokens({ inputTokens: 500_000 }) }
  assert.equal(usageCost(tokens({ inputTokens: 1_000_000 }), plain, split), 1)
  assert.equal(tierCost(tokens({ inputTokens: 1_000_000 }), plain, 'peak'), 1)
  assert.equal(tierCost(tokens({ inputTokens: 1_000_000 }), plain, 'offPeak'), 1)
  // 没有单价的模型依旧返回 null，不拿 0 冒充
  assert.equal(usageCost(tokens({ inputTokens: 1_000_000 }), undefined, split), null)
  assert.equal(tierCost(tokens({ inputTokens: 1_000_000 }), undefined, 'peak'), null)
})

test('计价：全落在高峰时，拆分后合计和未拆分的单一价完全相等', () => {
  const all = tokens({
    inputTokens: 1_000_000,
    cacheReadTokens: 200_000,
    cacheWriteTokens: 100_000,
    outputTokens: 300_000,
  })
  assert.equal(usageCost(all, flash, { peak: all, offPeak: zeros }), usageCost(all, flash))
  assert.equal(tierCost(all, flash, 'peak'), usageCost(all, flash))
  assert.equal(tierCost(zeros, flash, 'offPeak'), 0)
})

test('分档计价：tierCost 单独算一档，峰和谷的单价各是自己的', () => {
  const input = tokens({ inputTokens: 1_000_000 })
  assert.equal(tierCost(input, flash, 'peak'), 2)
  assert.equal(tierCost(input, flash, 'offPeak'), 1)
  assert.equal(tierCost(input, pro, 'peak'), 9)
  assert.equal(tierCost(input, pro, 'offPeak'), 4.5)
})

test('按模型标识计价：带上拆分时也走同一套', () => {
  const split = { peak: tokens({ inputTokens: 1_000_000 }), offPeak: tokens({ inputTokens: 1_000_000 }) }
  assert.equal(usageCostOf(tokens({ inputTokens: 2_000_000 }), 'deepseek-flash', split), 3)
  assert.equal(usageCostOf(tokens({ inputTokens: 1_000_000 }), 'deepseek-chat'), null)
})
