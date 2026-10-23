import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PRICING_MODEL, PRICING_MODELS, formatMoney, pricingModel, usageCost, usageCostOf } from './pricing.ts'

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
  }
  assert.deepEqual(flash?.prices, { inputMiss: 2, cacheHit: 0.04, cacheWrite: 2, output: 8 })
  assert.deepEqual(pro?.prices, { inputMiss: 9, cacheHit: 0.3, cacheWrite: 9, output: 27 })
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
