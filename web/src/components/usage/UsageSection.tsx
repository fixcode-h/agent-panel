import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { t } from '@shared/i18n'
import {
  USAGE_GRAINS,
  USAGE_LOOKBACK_DAYS,
  dayKey,
  formatTokens,
  isCurrentPeriod,
  periodLabel,
  periodStart,
  shiftPeriod,
  sumBuckets,
  usagePeriod,
  type UsageBucket,
  type UsageGrain,
  type UsageReport,
} from '@shared/usage'
import { DEFAULT_PRICING_MODEL, PRICING_MODELS, formatMoney, pricingModel, tierCost, usageCost } from '@shared/pricing'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { HelpTip } from '@/components/ui/help-tip'
import { Select } from '@/components/ui/input'
import { PeriodPicker } from './PeriodPicker'

/** 千分位：精确原值放 title，表格里显示短格式 */
const num = (n: number) => Math.round(n).toLocaleString()

const WEEKDAY = [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')]

/** 表格里的日期：10月23日 周五；窄屏只留日期，免得把轮数列挤出去 */
function Day({ day }: { day: Date }) {
  return (
    <td className="px-2.5 py-1.5 whitespace-nowrap">
      {t('{m}月{d}日', { m: day.getMonth() + 1, d: day.getDate() })}
      <span className="ml-1 hidden text-muted sm:inline">{WEEKDAY[day.getDay()]}</span>
    </td>
  )
}

/** 数字单元格：短格式 + 鼠标移上去看精确值，等宽字体对齐 */
function Tokens({ value }: { value: number }) {
  return (
    <td className="px-2.5 py-1.5 text-right font-mono tabular-nums" title={num(value)}>
      {formatTokens(value)}
    </td>
  )
}

/** 汇总区的一个指标 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.6875rem] text-subtle">{label}</div>
      <div className="truncate font-mono text-[0.8125rem] tabular-nums" title={num(value)}>
        {formatTokens(value)}
      </div>
    </div>
  )
}

/**
 * 设置里的「用量统计」：按天 / 按周 / 按月只展示当前一个区间，用工具条上的选择器切区间。
 *
 * 聚合仍在服务端做（`GET /usage`），一次取近一年的按天数据；周、月的合计由按天相加，
 * 所以切粒度不用重新请求。切粒度总是落在新粒度的当前区间（今天 / 本周 / 本月），
 * 翻区间、选日期后区间不在当前时工具条上多一个「重置」回到当前。
 * 当前区间还没有用量时退到最近一个有数据的区间并在界面上写清显示的是哪一段
 * （用户手动选过的区间不会被自动改掉）。
 *
 * 费用按「计价模型」的官方单价折算（`shared/pricing.ts`）；CLI 自己上报的 costUsd 只作对照，
 * 不参与合计，避免两个都叫「费用」的数字混在一起。
 */
export function UsageSection({
  pricingModel: pricingId,
  onPricingModel,
}: {
  /** 设置里存的计价模型标识 */
  pricingModel: string
  onPricingModel: (id: string) => void
}) {
  const [grain, setGrain] = useState<UsageGrain>('day')
  /** 当前区间的第一天；按天是那天，按周是周一，按月是一号 */
  const [anchor, setAnchor] = useState<Date>(() => new Date())
  /** 用户主动选过区间（翻区间、选日期、点重置）：不再自动退到最近有数据的那一段 */
  const [picked, setPicked] = useState(false)
  /** 默认定位时因为今天 / 本周 / 本月没有用量后退了：只在这一次说清显示了哪一段 */
  const [fallback, setFallback] = useState(false)
  const [report, setReport] = useState<UsageReport>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const tabRefs = useRef<Partial<Record<UsageGrain, HTMLButtonElement | null>>>({})

  useEffect(() => {
    let dead = false
    setLoading(true)
    setError('')
    api
      .tokenUsage({ grain: 'day', count: USAGE_LOOKBACK_DAYS })
      .then((r) => !dead && setReport(r))
      .catch((e) => !dead && setError((e as Error).message))
      .finally(() => !dead && setLoading(false))
    return () => {
      dead = true
    }
  }, [tick])

  const byDay = useMemo(() => new Map((report?.buckets ?? []).map((b) => [b.key, b])), [report])
  const marked = useMemo(() => new Set((report?.buckets ?? []).filter((b) => b.turns > 0).map((b) => b.key)), [report])
  const selected = useMemo(() => usagePeriod(grain, anchor), [grain, anchor])
  const rows = useMemo(
    () =>
      selected.days
        .map((d) => byDay.get(dayKey(d)))
        .filter((b): b is UsageBucket => !!b && b.turns > 0)
        .reverse(),
    [selected, byDay],
  )
  const total = useMemo(() => sumBuckets(rows), [rows])

  // 设置弹窗打开时焦点落在粒度选择器上，打开就能用方向键切换
  useEffect(() => {
    const id = requestAnimationFrame(() => tabRefs.current.day?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // 默认落在今天 / 本周 / 本月；一段都没用量时退到最近有数据的那一段（用户选过就不再动）
  useEffect(() => {
    if (!report || picked) return
    const period = usagePeriod(grain, new Date())
    const used = period.days.some((d) => (byDay.get(dayKey(d))?.turns ?? 0) > 0)
    if (used) {
      setFallback(false)
      return
    }
    const latest = report.buckets.find((b) => b.turns > 0)
    if (!latest) return
    setAnchor(periodStart(grain, new Date(latest.start)))
    setFallback(true)
  }, [report, grain, picked, byDay])

  const today0 = new Date()
  const todayStart = periodStart('day', today0)
  const min = report?.buckets.length ? new Date(report.buckets[report.buckets.length - 1].start) : todayStart
  // 数据只有过去一年，但日历要能前后翻月：往后也留一年，翻到未来显示「这段时间暂无用量」
  const max = periodStart('day', new Date(today0.getFullYear() + 1, today0.getMonth(), today0.getDate()))

  const model = pricingModel(pricingId)
  const currency = model?.currency ?? 'CNY'
  // 聚合层已经按轮把 token 拆成峰 / 谷两组，两边各自乘单价后相加
  const cost = usageCost(total, model, total)
  // 官方分时段定价的模型才显示峰谷明细；不支持的模型只有单一价
  const tiered = !!model?.offPeakPrices
  const peakCost = tierCost(total.peak, model, 'peak')
  const offPeakCost = tierCost(total.offPeak, model, 'offPeak')
  /** 一档的 token 量（输入 + 输出，和表格口径一致） */
  const tierTokens = (x: { inputTokens: number; outputTokens: number }) => x.inputTokens + x.outputTokens
  const shown = periodLabel(selected)
  // 已经在当前区间（今天 / 本周 / 本月）时没什么可重置的，按钮不显示
  const onCurrent = isCurrentPeriod(grain, selected.start, today0)
  const fellBack = fallback && !picked && !onCurrent && rows.length > 0

  const select = (day: Date) => {
    setAnchor(periodStart(grain, day))
    setPicked(true)
    setFallback(false)
  }
  const step = (n: number) => {
    setAnchor(shiftPeriod(grain, selected.start, n))
    setPicked(true)
    setFallback(false)
  }
  /** 重置 / T 键：回到这个粒度对应的今天、本周、本月（和截图里「回到今天」同一个语义） */
  const resetToCurrent = () => {
    setAnchor(periodStart(grain, new Date()))
    setPicked(true)
    setFallback(false)
  }
  const changeGrain = (g: UsageGrain) => {
    // 换粒度就落到新粒度的当前区间（今天 / 本周 / 本月），不停在旧区间
    setGrain(g)
    setAnchor(periodStart(g, new Date()))
    setPicked(false)
    setFallback(false)
  }

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const ids = USAGE_GRAINS.map((g) => g.id)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = ids.length - 1
    if (next < 0) return
    e.preventDefault()
    e.stopPropagation()
    changeGrain(ids[next])
    tabRefs.current[ids[next]]?.focus()
  }

  /** 区块内的快捷键：输入框、下拉框、日历弹层、计价模型下拉里不拦截 */
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const el = e.target as HTMLElement
    if (el.closest('input, textarea, select, [contenteditable="true"], [data-radix-popper-content-wrapper]')) return
    const key = e.key.toLowerCase()
    if (key === '[') {
      e.preventDefault()
      step(-1)
    } else if (key === ']') {
      e.preventDefault()
      step(1)
    } else if (key === 't') {
      e.preventDefault()
      resetToCurrent()
    } else if (key === 'r') {
      e.preventDefault()
      setTick((n) => n + 1)
    }
  }

  const fallbackText =
    grain === 'day'
      ? t('今天还没有用量，显示最近有数据的一天：{shown}', { shown })
      : grain === 'week'
        ? t('本周还没有用量，显示最近有数据的一周：{shown}', { shown })
        : t('本月还没有用量，显示最近有数据的一个月：{shown}', { shown })
  const resetTitle = grain === 'day' ? t('重置到今天') : grain === 'week' ? t('重置到本周') : t('重置到本月')

  const listEmpty = !loading && !rows.length

  return (
    <section className="flex flex-col gap-3" onKeyDown={onKeyDown} aria-label={t('用量统计')}>
      {/* 统一工具条：粒度、时间范围、计价模型、刷新排成一行，窄窗口换行不溢出 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label={t('统计粒度')}>
          {USAGE_GRAINS.map((g, i) => (
            <button
              key={g.id}
              ref={(el) => {
                tabRefs.current[g.id] = el
              }}
              type="button"
              role="tab"
              aria-selected={grain === g.id}
              tabIndex={grain === g.id ? 0 : -1}
              onClick={() => changeGrain(g.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={cn(
                'h-7 cursor-pointer rounded-md px-2.5 text-[0.78125rem] transition-colors',
                grain === g.id ? 'bg-sel font-medium text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <PeriodPicker
          grain={grain}
          start={anchor}
          marked={marked}
          min={min}
          max={max}
          onChange={select}
          label={shown}
        />
        {/* 手动了区间才出现：已经在今天 / 本周 / 本月时按钮不占位置 */}
        {!onCurrent && (
          <Button variant="ghost" size="sm" title={resetTitle} onClick={resetToCurrent}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('重置')}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Select
            aria-label={t('计价模型')}
            className="h-8 w-[200px]"
            value={pricingId || DEFAULT_PRICING_MODEL}
            options={PRICING_MODELS.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(e) => onPricingModel(e.target.value)}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('刷新用量（R）')}
            title={t('刷新用量（R）')}
            disabled={loading}
            onClick={() => setTick((n) => n + 1)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* 统计口径和快捷键一次说清，按钮上的 title 也带着 */}
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '按本机本地时间统计每轮执行的 token，一轮算在它开始的那一天（周从周一起算）。输入含缓存命中和缓存写入的部分。',
        )}
      </p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-subtle">
        <span>
          <kbd className="rounded border px-1 font-mono">[</kbd> <kbd className="rounded border px-1 font-mono">]</kbd>{' '}
          {t('切换区间')}
        </span>
        <span>
          <kbd className="rounded border px-1 font-mono">T</kbd> {t('回到今天')}
        </span>
        <span>
          <kbd className="rounded border px-1 font-mono">R</kbd> {t('刷新')}
        </span>
        <span>
          <kbd className="rounded border px-1 font-mono">Esc</kbd> {t('关闭设置')}
        </span>
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
      {fellBack && <p className="text-[0.75rem] text-muted">{fallbackText}</p>}

      {/* 汇总：费用放最显眼的位置，其他指标一格一个，一屏内看全 */}
      <div className="rounded-xl border bg-field/40 px-3.5 py-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-[160px]">
            <div className="flex items-center gap-1 text-[0.6875rem] text-subtle">
              {t('费用')}
              <HelpTip>
                <span className="block">
                  {model
                    ? t(
                        '按 {model} 官方 API 单价折算（元 / 百万 token，{date}）：输入 {input}、输出 {output}、缓存命中 {hit}、缓存写入 {write}。官方分高峰、空闲两档，空闲价是高峰价的一半；北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰，其余时段（含周末、法定节假日）为空闲。每一轮按它开始的时间归档。缓存写入官方没有单列，按未命中输入价计。',
                        {
                          model: model.label,
                          date: model.priceAt,
                          input: formatMoney(model.prices.inputMiss),
                          output: formatMoney(model.prices.output),
                          hit: formatMoney(model.prices.cacheHit),
                          write: formatMoney(model.prices.cacheWrite),
                        },
                      )
                    : t('这个计价模型没有配置单价，费用按 0 处理。')}
                </span>
                {total.costUsd > 0 && (
                  <span className="mt-1 block text-subtle">
                    {t('CLI 上报的费用（{cost}）只作对照，不参与合计。', {
                      cost: formatMoney(total.costUsd, 'USD'),
                    })}
                  </span>
                )}
              </HelpTip>
            </div>
            <div className="mt-0.5 font-mono text-[1.375rem] leading-tight font-semibold tabular-nums">
              {cost === null ? (
                <span className="text-[0.9375rem] font-normal text-subtle">{t('未配置单价')}</span>
              ) : (
                formatMoney(cost, currency)
              )}
            </div>
            <div className="mt-0.5 text-[0.6875rem] text-subtle">
              {model ? t('按 {model} 单价估算', { model: model.label }) : t('未配置单价')}
              {total.turns > 0 && ` · ${t('共 {n} 轮', { n: num(total.turns) })}`}
            </div>
            {/* 峰谷明细：只占一行小字，不撑宽表格；分时段定价的模型才显示 */}
            {tiered && total.turns > 0 && (
              <div
                className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.6875rem] text-subtle"
                data-usage-tiers
              >
                <span title={t('高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00')}>
                  {t('高峰 {tokens} · {cost}', {
                    tokens: formatTokens(tierTokens(total.peak)),
                    cost: peakCost === null ? t('未配置单价') : formatMoney(peakCost, currency),
                  })}
                </span>
                <span title={t('空闲时段：其余时间，含周末和法定节假日')}>
                  {t('空闲 {tokens} · {cost}', {
                    tokens: formatTokens(tierTokens(total.offPeak)),
                    cost: offPeakCost === null ? t('未配置单价') : formatMoney(offPeakCost, currency),
                  })}
                </span>
              </div>
            )}
          </div>
          <div className="grid flex-1 basis-[420px] grid-cols-3 gap-x-6 gap-y-2 sm:grid-cols-6">
            <Stat label={t('输入')} value={total.inputTokens} />
            <Stat label={t('输出')} value={total.outputTokens} />
            <Stat label={t('缓存命中')} value={total.cacheReadTokens} />
            <Stat label={t('缓存写入')} value={total.cacheWriteTokens} />
            <Stat label={t('任务')} value={total.tasks} />
            <Stat label={t('轮数')} value={total.turns} />
          </div>
        </div>
      </div>

      {/* 明细：区间里有数据的天，从新到旧；表尾合计和上面汇总一致 */}
      <div
        tabIndex={0}
        role="region"
        aria-label={t('用量明细（{range}）', { range: shown })}
        title={t('用量明细（{range}）', { range: shown })}
        className="max-h-[min(46vh,420px)] overflow-y-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-focus-soft"
      >
        {listEmpty ? (
          <div className="px-3.5 py-8 text-center text-[0.8125rem] text-subtle">
            {loading ? '…' : t('这段时间暂无用量')}
          </div>
        ) : (
          <table className="w-full text-[0.78125rem] [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
            <thead>
              <tr className="sticky top-0 z-10 border-b bg-card text-left text-[0.6875rem] text-subtle">
                <th className="px-2.5 py-2 font-medium whitespace-nowrap">{t('时间')}</th>
                <th className="px-2.5 py-2 text-right font-medium">{t('输入')}</th>
                <th className="px-2.5 py-2 text-right font-medium">{t('输出')}</th>
                <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">{t('缓存命中')}</th>
                <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">{t('缓存写入')}</th>
                <th
                  className="px-2.5 py-2 text-right font-medium whitespace-nowrap"
                  title={
                    tiered
                      ? t('{unit} / 百万 token · {model} 按峰谷分档计价', {
                          unit: currency === 'CNY' ? t('元') : t('美元'),
                          model: model?.label ?? '',
                        })
                      : t('{unit} / 百万 token · {model} 高峰时段单价', {
                          unit: currency === 'CNY' ? t('元') : t('美元'),
                          model: model?.label ?? '',
                        })
                  }
                >
                  {t('费用')}
                </th>
                <th className="hidden px-2.5 py-2 text-right font-medium md:table-cell">{t('任务')}</th>
                <th className="hidden px-2.5 py-2 text-right font-medium whitespace-nowrap sm:table-cell">
                  {t('轮数')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const dayCost = usageCost(b, model, b)
                return (
                  <tr key={b.key} className="border-b last:border-b-0 hover:bg-sel/30">
                    <Day day={new Date(b.start)} />
                    <Tokens value={b.inputTokens} />
                    <Tokens value={b.outputTokens} />
                    <td
                      className="hidden px-2.5 py-1.5 text-right font-mono tabular-nums sm:table-cell"
                      title={num(b.cacheReadTokens)}
                    >
                      {formatTokens(b.cacheReadTokens)}
                    </td>
                    <td
                      className="hidden px-2.5 py-1.5 text-right font-mono tabular-nums sm:table-cell"
                      title={num(b.cacheWriteTokens)}
                    >
                      {formatTokens(b.cacheWriteTokens)}
                    </td>
                    <td
                      className="px-2.5 py-1.5 text-right font-mono tabular-nums"
                      title={
                        dayCost === null
                          ? t('未配置单价')
                          : tiered
                            ? t('{total}（高峰 {peak} · 空闲 {offPeak}）', {
                                total: formatMoney(dayCost, currency),
                                peak: formatMoney(tierCost(b.peak, model, 'peak') ?? 0, currency),
                                offPeak: formatMoney(tierCost(b.offPeak, model, 'offPeak') ?? 0, currency),
                              })
                            : formatMoney(dayCost, currency)
                      }
                    >
                      {dayCost === null ? (
                        <span className="text-subtle">{t('未配置单价')}</span>
                      ) : (
                        formatMoney(dayCost, currency)
                      )}
                    </td>
                    <td
                      className="hidden px-2.5 py-1.5 text-right font-mono tabular-nums md:table-cell"
                      title={num(b.tasks)}
                    >
                      {formatTokens(b.tasks)}
                    </td>
                    <td
                      className="hidden px-2.5 py-1.5 text-right font-mono tabular-nums sm:table-cell"
                      title={num(b.turns)}
                    >
                      {formatTokens(b.turns)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t bg-field/60 font-medium">
                <td className="px-2.5 py-2 whitespace-nowrap">{t('合计')}</td>
                <td className="px-2.5 py-2 text-right font-mono tabular-nums" title={num(total.inputTokens)}>
                  {formatTokens(total.inputTokens)}
                </td>
                <td className="px-2.5 py-2 text-right font-mono tabular-nums" title={num(total.outputTokens)}>
                  {formatTokens(total.outputTokens)}
                </td>
                <td
                  className="hidden px-2.5 py-2 text-right font-mono tabular-nums sm:table-cell"
                  title={num(total.cacheReadTokens)}
                >
                  {formatTokens(total.cacheReadTokens)}
                </td>
                <td
                  className="hidden px-2.5 py-2 text-right font-mono tabular-nums sm:table-cell"
                  title={num(total.cacheWriteTokens)}
                >
                  {formatTokens(total.cacheWriteTokens)}
                </td>
                <td
                  className="px-2.5 py-2 text-right font-mono tabular-nums"
                  title={cost === null ? t('未配置单价') : formatMoney(cost, currency)}
                >
                  {cost === null ? <span className="text-subtle">{t('未配置单价')}</span> : formatMoney(cost, currency)}
                </td>
                <td
                  className="hidden px-2.5 py-2 text-right font-mono tabular-nums md:table-cell"
                  title={num(total.tasks)}
                >
                  {formatTokens(total.tasks)}
                </td>
                <td
                  className="hidden px-2.5 py-2 text-right font-mono tabular-nums sm:table-cell"
                  title={num(total.turns)}
                >
                  {formatTokens(total.turns)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </section>
  )
}
