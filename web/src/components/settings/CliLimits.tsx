import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { CliLimits } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 能显示额度的 CLI：Codex 可以主动查，Claude Code 执行时会推送；Command Code 不提供 */
export const LIMIT_CLIS = ['codex', 'claude']

/**
 * 上次读到的额度：先显示它，读到最新的再换掉，不用每次打开都等「读取中」。
 * 存在浏览器里，刷新页面后也能马上显示；读不到存储时只在这次打开期间记着
 */
const KEY = 'agent-panel:cli-limits'
const lastLimits = new Map<string, CliLimits>(
  (() => {
    try {
      return Object.entries(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, CliLimits>)
    } catch {
      return []
    }
  })(),
)
function remember(cli: string, d: CliLimits) {
  lastLimits.set(cli, d)
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(lastLimits)))
  } catch {}
}

/** 额度：打开时查一次，之后每分钟刷新（执行中 CLI 推送的新数据也会在这时带上）；查到之前先显示上次的 */
export function useCliLimits(cli: string, enabled: boolean) {
  const [data, setData] = useState<CliLimits | null>(() => lastLimits.get(cli) ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = () => {
    setLoading(true)
    api
      .cliLimits(cli)
      .then((d) => {
        // 这次没读到（例如 Claude Code 还没执行过）就留着上次的
        if (d?.windows.length || !lastLimits.has(cli)) setData(d)
        if (d?.windows.length) remember(cli, d)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    setData(lastLimits.get(cli) ?? null)
    setError('')
    if (!enabled || !LIMIT_CLIS.includes(cli)) return
    load()
    const timer = setInterval(load, 60_000)
    return () => clearInterval(timer)
    // load 每次渲染都是新的函数，只在 CLI 或开关变化时重新开始
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, enabled])
  return { data, error, loading, reload: load }
}

const windowName = (id: string, minutes?: number) =>
  ({
    five_hour: t('5 小时'),
    seven_day: t('每周'),
    seven_day_opus: t('每周 · Opus'),
    seven_day_sonnet: t('每周 · Sonnet'),
    seven_day_overage_included: t('每周（含超额）'),
  })[id] ?? (minutes ? t('{n} 分钟', { n: minutes }) : id)

/** 重置时间：一天内写「x 小时后」，再远写日期 */
function resetText(at?: number) {
  if (!at) return ''
  const ms = at - Date.now()
  if (ms <= 0) return t('已重置')
  const min = Math.round(ms / 60_000)
  if (min < 60) return t('{n} 分钟后重置', { n: min })
  if (min < 24 * 60) return t('{n} 小时后重置', { n: Math.round(min / 60) })
  const d = new Date(at)
  return t('{date} 重置', {
    date: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  })
}

/** 额度的几个窗口，每个一条进度条 */
export function LimitBars({ data, compact }: { data: CliLimits; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col', compact ? 'gap-2' : 'gap-3')}>
      {data.windows.map((w) => {
        const pct = Math.max(0, Math.min(100, w.usedPercent))
        const tone = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-accent'
        return (
          <div key={w.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2 text-[12px]">
              <span className="text-fg">{windowName(w.id, w.minutes)}</span>
              <span className="font-mono text-muted">{t('已用 {n}%', { n: Math.round(pct) })}</span>
              <span className="ml-auto text-subtle">{resetText(w.resetsAt)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-sel">
              <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
      {data.limited && <p className="text-[12px] text-danger">{t('额度已经用完，等重置后才能继续用')}</p>}
    </div>
  )
}

/** 设置页里的额度：没有数据时说明原因 */
export function CliLimitsPanel({ cli }: { cli: string }) {
  const { data, error, loading, reload } = useCliLimits(cli, true)
  return (
    <div className="flex flex-col gap-2">
      {data?.windows.length ? (
        <LimitBars data={data} />
      ) : (
        <p className="text-[12px] text-subtle">
          {error
            ? t('读取失败：{error}', { error })
            : loading
              ? t('读取中…')
              : cli === 'claude'
                ? t('Claude Code 在执行时才报告额度，跑过一次任务后这里会显示')
                : t('没有读到额度（用 API Key 登录时没有额度限制）')}
        </p>
      )}
      <div className="flex items-center gap-2 text-[11px] text-subtle">
        {data?.plan && <span>{t('套餐：{plan}', { plan: data.plan })}</span>}
        <button
          onClick={reload}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 text-accent"
          disabled={loading}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          {t('刷新')}
        </button>
      </div>
    </div>
  )
}
