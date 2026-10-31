import { uiLocale } from './i18n.ts'
import { DEEPSEEK_PEAK_WINDOW, type PeakWindow, type TokenTotals } from './usage.ts'

/**
 * 用量计价：把 token 按某个模型的官方 API 单价折成费用。给设置页「用量统计」的「计价模型」用。
 *
 * 单价集中在这个文件里，改价只动 `PRICING_MODELS`，界面和合计都走 `usageCost`，不在 UI 里散落数字。
 *
 * 来源：DeepSeek 官方定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * （2026-10-23 抓取，单位「元 / 百万 token」）。官方分高峰、空闲两档，空闲价是高峰价的一半：
 * 「空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、
 * 14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」
 * 时段定义在 `shared/usage.ts` 的 `DEEPSEEK_PEAK_WINDOW`（聚合时按它拆分每轮的 token）。
 * 法定节假日没有内置表，按高峰价算（价格更高，不会低估）。
 *
 * 官方没有单列「缓存写入」的单价：DeepSeek 只对「命中缓存的输入」单独计价，其余的输入按
 * 「缓存未命中输入」计费，缓存写入属于后者，因此 `cacheWrite` 映射成 `inputMiss` 的价。
 * 本文件里两个模型的 cacheWrite 都等于 inputMiss，以后官方单独公布写入价时只改这一项。
 */

/** 每百万 token 的单价（元） */
export type TokenPrices = {
  /** 输入里没有命中缓存的部分 */
  inputMiss: number
  /** 输入里命中缓存的部分 */
  cacheHit: number
  /** 输入里写入缓存的部分；官方没有单列，映射为 inputMiss */
  cacheWrite: number
  /** 输出 */
  output: number
}

export type Currency = 'CNY' | 'USD'

export type PricingModel = {
  /** 写进设置里的标识，改价时不要改它（会丢用户的选择） */
  id: string
  /** 界面上显示的名字 */
  label: string
  currency: Currency
  /** 高峰时段单价；官方不分时段的模型就只有这一套，界面按它计价 */
  prices: TokenPrices
  /**
   * 空闲（优惠）时段单价：只有官方分时段定价的模型才有。
   * 没有它的模型一律按 `prices` 算（回落单一价），不会凭空拆成两档。
   */
  offPeakPrices?: TokenPrices
  /** 判定峰谷用的时段定义；有 `offPeakPrices` 时聚合按它拆分，没填就用官方那一套 */
  window?: PeakWindow
  /** 价格来源（官方页面）和抓取日期，界面提示里显示 */
  source: string
  priceAt: string
}

/** 计价模型的顺序就是下拉框里的顺序；第一项是默认值 */
export const PRICING_MODELS: PricingModel[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    currency: 'CNY',
    prices: { inputMiss: 2, cacheHit: 0.04, cacheWrite: 2, output: 8 },
    offPeakPrices: { inputMiss: 1, cacheHit: 0.02, cacheWrite: 1, output: 4 },
    window: DEEPSEEK_PEAK_WINDOW,
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    priceAt: '2026-10-23',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    currency: 'CNY',
    prices: { inputMiss: 9, cacheHit: 0.3, cacheWrite: 9, output: 27 },
    offPeakPrices: { inputMiss: 4.5, cacheHit: 0.15, cacheWrite: 4.5, output: 13.5 },
    window: DEEPSEEK_PEAK_WINDOW,
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    priceAt: '2026-10-23',
  },
]

/** 设置里没存过时用的模型 */
export const DEFAULT_PRICING_MODEL = PRICING_MODELS[0].id

/** 按标识找模型；找不到（例如设置里存的是已下线的模型）返回 undefined，界面显示「未配置单价」 */
export function pricingModel(id: string | undefined): PricingModel | undefined {
  return PRICING_MODELS.find((m) => m.id === id)
}

/** 计价要用的 token：输入含缓存命中和缓存写入（和 Task.usage 的口径一致） */
export type UsageTokens = TokenTotals

/** 按峰 / 谷拆开的用量：聚合层（`shared/usage.ts`）已经拆好，计价只负责乘单价 */
export type SplitUsage = {
  peak: TokenTotals
  offPeak: TokenTotals
}

/** 一套单价算一遍：输入已经含缓存部分，先把命中、写入的拆出来，剩下的按未命中价算 */
function costAt(tokens: TokenTotals, p: TokenPrices): number {
  const input = Math.max(0, tokens.inputTokens)
  const cacheHit = Math.min(Math.max(0, tokens.cacheReadTokens), input)
  const cacheWrite = Math.min(Math.max(0, tokens.cacheWriteTokens), input - cacheHit)
  const miss = input - cacheHit - cacheWrite
  const output = Math.max(0, tokens.outputTokens)
  const perMillion = miss * p.inputMiss + cacheHit * p.cacheHit + cacheWrite * p.cacheWrite + output * p.output
  return perMillion / 1_000_000
}

/**
 * 一次用量按某个模型折成费用。
 * 模型分时段定价（有 `offPeakPrices`）而且拿到了按轮拆分的用量时，两档分别计价后相加；
 * 其余情况一律按高峰价（单一价）算——不拿一个假的两档拆分冒充。
 * 历史数据里缓存数偶尔大于输入（口径调整前后的旧任务），`costAt` 里先夹到输入以内再拆。
 * 模型没有单价时返回 null：界面显示「未配置单价」，不拿 0 冒充。
 */
export function usageCost(tokens: UsageTokens, model: PricingModel | undefined, split?: SplitUsage): number | null {
  if (!model) return null
  if (split && model.offPeakPrices) {
    return costAt(split.peak, model.prices) + costAt(split.offPeak, model.offPeakPrices)
  }
  return costAt(tokens, model.prices)
}

/** 单独算某一档的费用：界面上的峰 / 谷明细用它，模型不分时段时两档都用同一个价 */
export function tierCost(
  tokens: TokenTotals,
  model: PricingModel | undefined,
  tier: 'peak' | 'offPeak',
): number | null {
  if (!model) return null
  return costAt(tokens, tier === 'offPeak' ? (model.offPeakPrices ?? model.prices) : model.prices)
}

/** 按模型标识计价：设置里存的 id 直接传进来 */
export function usageCostOf(tokens: UsageTokens, modelId: string | undefined, split?: SplitUsage): number | null {
  return usageCost(tokens, pricingModel(modelId), split)
}

const SYMBOL: Record<Currency, string> = { CNY: '¥', USD: '$' }

/** Intl 实例复用：表格每行都格式化，别每次 new（和对话框里 formatAt 的教训一致） */
const moneyFormats = new Map<string, Intl.NumberFormat>()

function moneyFormat(currency: Currency, digits: number) {
  const key = `${currency}-${digits}`
  let f = moneyFormats.get(key)
  if (!f) {
    f = new Intl.NumberFormat(uiLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })
    moneyFormats.set(key, f)
  }
  return f
}

/**
 * 金额：保留 2 位小数、带千分位；分以下的小额多留两位（和以前 `usd()` 的意图一致），
 * 免得一笔很便宜的费用全显示成 ¥0.00。
 */
export function formatMoney(n: number, currency: Currency = 'CNY') {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  const digits = v > 0 && v < 0.01 ? 4 : 2
  return `${SYMBOL[currency] ?? ''}${moneyFormat(currency, digits).format(v)}`
}
