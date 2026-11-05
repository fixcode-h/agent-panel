import { useEffect, useState } from 'react'
import { Gauge, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { ApiConfig } from '@shared/accounts'
import type { SpeedRow } from '@shared/api-speed'
import { fmtDuration } from '@shared/duration'
import { SLOW_FIRST_TOKEN_MS } from '@shared/first-token'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * API 设置里的「测速」：对这个 API 支持的每种协议各发一个小请求、一个约 2 万 token 的大请求，看首包要等多久。
 * Agent 每一步都带着整段上下文，大请求的首包才接近真实体感；同一个中转站不同协议能差出十倍，
 * 一个 API 支持几种协议时，按这里的结果给 Agent 挑快的那种（Agent 设置里选协议）
 */
export function ApiSpeedTest({ a, model, disabled }: { a: ApiConfig; model: string; disabled?: boolean }) {
  const [rows, setRows] = useState<SpeedRow[]>()
  const [running, setRunning] = useState(false)
  const key = JSON.stringify([a.protocol, a.baseUrl, a.endpoints, a.apiKey, a.authHeader])
  // 连接相关的字段一改，上一次的结果就不算数了
  useEffect(() => setRows(undefined), [key])

  const run = async () => {
    setRunning(true)
    try {
      setRows((await api.apiSpeed(a, model)).rows)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const protocols = [...new Set((rows ?? []).map((r) => r.protocol))]
  const cell = (r: SpeedRow | undefined) =>
    !r ? (
      <span className="text-subtle">—</span>
    ) : r.error ? (
      <span className="text-danger" title={r.error}>
        {t('失败')}
      </span>
    ) : (
      <span className={cn('tabular-nums', (r.firstMs ?? 0) >= SLOW_FIRST_TOKEN_MS ? 'text-warning' : 'text-fg')}>
        {fmtDuration(r.firstMs ?? 0)}
      </span>
    )

  return (
    <div className="flex flex-col gap-2" data-api-speed>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-footnote text-subtle">
          {t('测速：每种协议发一个小请求和一个约 2 万 token 的大请求，看首包要等多久（会用掉少量额度）')}
        </span>
        <Button size="sm" variant="secondary" disabled={disabled || running || !model} onClick={run}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gauge className="h-3.5 w-3.5" />}
          {t('测速')}
        </Button>
      </div>
      {rows && (
        <table className="w-full text-footnote">
          <thead>
            <tr className="text-left text-subtle">
              <th className="py-1 font-normal">{t('协议')}</th>
              <th className="py-1 font-normal">{t('小请求首包')}</th>
              <th className="py-1 font-normal">{t('大请求首包')}</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {protocols.map((p) => {
              const small = rows.find((r) => r.protocol === p && r.size === 'small')
              const large = rows.find((r) => r.protocol === p && r.size === 'large')
              return (
                <tr key={p} className="border-t border-line">
                  <td className="py-1 pr-2">{p}</td>
                  <td className="py-1 pr-2">{cell(small)}</td>
                  <td className="py-1">{cell(large)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {rows?.some((r) => r.error) && (
        <ul className="flex flex-col gap-0.5 text-caption text-danger">
          {rows
            .filter((r) => r.error)
            .map((r) => (
              <li key={`${r.protocol}-${r.size}`} className="break-words">
                {r.protocol} · {r.size === 'small' ? t('小请求') : t('大请求')}：{r.error}
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}
