import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import { USAGE_GRAINS, usageCount, usageLabel, type UsageGrain, type UsageReport } from '@shared/usage'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 取用量报表：由设置页传进来（接的是 `api.tokenUsage`），组件自己不关心怎么请求 */
export type UsageLoad = (q: { grain: UsageGrain; count: number }) => Promise<UsageReport>

/** 千分位，等宽字体对齐由表格的 font-mono 负责 */
const num = (n: number) => n.toLocaleString()

/** 费用：分以下的小额多留两位，免得显示成 $0.00 */
const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`

/**
 * 设置里的「用量统计」：按天 / 周 / 月看 token 用量。
 * 聚合在服务端做，这里只拿到几十个桶；老任务没有轮次明细时服务端就不计入，界面只会显示「暂无用量」。
 */
export function UsageSection({ load }: { load?: UsageLoad }) {
  const [grain, setGrain] = useState<UsageGrain>('day')
  const [report, setReport] = useState<UsageReport>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    // 接口还没接上时先不请求，界面显示空状态
    if (!load) return
    let dead = false
    setLoading(true)
    setError('')
    load({ grain, count: usageCount(grain) })
      .then((r) => !dead && setReport(r))
      .catch((e) => !dead && setError((e as Error).message))
      .finally(() => !dead && setLoading(false))
    return () => {
      dead = true
    }
  }, [grain, load, tick])

  const total = report?.total
  const buckets = report?.buckets ?? []
  const hasCost = !!total && total.costUsd > 0

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[0.8125rem] font-semibold">{t('用量统计')}</h3>
        {!!total?.turns && <span className="text-xs text-subtle">{t('共 {n} 轮', { n: num(total.turns) })}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label={t('统计粒度')}>
            {USAGE_GRAINS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={grain === g.id}
                onClick={() => setGrain(g.id)}
                className={cn(
                  'h-6 cursor-pointer rounded-md px-2.5 text-[0.78125rem] transition-colors',
                  grain === g.id ? 'bg-sel font-medium text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('刷新用量')}
            disabled={loading || !load}
            onClick={() => setTick((n) => n + 1)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '按本机本地时间统计每轮执行的 token，一轮算在它开始的那一天（周从周一起算）。输入含缓存命中和缓存写入的部分。',
        )}
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!total?.turns ? (
        <div className="rounded-xl border px-3.5 py-8 text-center text-[0.8125rem] text-subtle">
          {loading ? '…' : t('暂无用量')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[560px] text-[0.78125rem]">
            <thead>
              <tr className="border-b text-left text-[0.6875rem] text-subtle">
                <th className="px-3 py-2 font-medium">{t('时间')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('输入')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('输出')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('缓存命中')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('缓存写入')}</th>
                {hasCost && <th className="px-3 py-2 text-right font-medium">{t('费用')}</th>}
                <th className="px-3 py-2 text-right font-medium">{t('任务')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('轮数')}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key} className="border-b last:border-b-0">
                  <td className="px-3 py-1.5 whitespace-nowrap">{usageLabel(b, grain)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(b.inputTokens)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(b.outputTokens)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(b.cacheReadTokens)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(b.cacheWriteTokens)}</td>
                  {hasCost && <td className="px-3 py-1.5 text-right font-mono tabular-nums">{usd(b.costUsd)}</td>}
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(b.tasks)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(b.turns)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-field/60 font-medium">
                <td className="px-3 py-2">{t('合计')}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{num(total.inputTokens)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{num(total.outputTokens)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{num(total.cacheReadTokens)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{num(total.cacheWriteTokens)}</td>
                {hasCost && <td className="px-3 py-2 text-right font-mono tabular-nums">{usd(total.costUsd)}</td>}
                <td className="px-3 py-2 text-right font-mono tabular-nums">{num(total.tasks)}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{num(total.turns)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}
