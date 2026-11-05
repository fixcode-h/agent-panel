import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { fmtDuration } from '@shared/duration'
import { firstTokenSummary, SLOW_FIRST_TOKEN_MS } from '@shared/first-token'
import { cn } from '@/lib/utils'
import { SessionCard } from './SessionCard'

/**
 * 会话栏「模型响应」：每次请求从交出去到第一段输出等了多久（首包），和平均输出速度。
 * 等模型的时间大多在这里：首包一直慢是接口 / 网络的问题（换链路、去 API 设置测速），
 * 首包快但一轮很久是模型在想、在写。数据由 runner 记进 AgentUsage.firstToken
 */
export function LatencyCard({ task }: { task: Task }) {
  const s = firstTokenSummary(task.usage?.agents)
  return (
    <SessionCard id="latency" title={t('模型响应')}>
      {!s ? (
        <p className="text-xs text-subtle">{t('模型回复后显示首包时间')}</p>
      ) : (
        <div className="flex flex-col gap-2" data-latency>
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'font-mono text-base font-semibold tabular-nums',
                s.recentAvgMs >= SLOW_FIRST_TOKEN_MS && 'text-warning',
              )}
            >
              {fmtDuration(s.recentAvgMs)}
            </span>
            <span className="text-xs text-subtle">{t('最近平均首包')}</span>
            {s.tps > 0 && (
              <span className="ml-auto font-mono text-xs whitespace-nowrap text-muted tabular-nums">
                {s.tps.toFixed(1)} t/s
              </span>
            )}
          </div>
          <Bars values={s.recent} />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            {(
              [
                [t('平均首包'), fmtDuration(s.avgMs)],
                [t('最长首包'), fmtDuration(s.maxMs)],
                [t('首包合计'), fmtDuration(s.sumMs)],
                [t('请求次数'), String(s.n)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <dt className="text-subtle">{k}</dt>
                <dd className="font-mono text-muted tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {s.recentAvgMs >= SLOW_FIRST_TOKEN_MS && (
            <p className="text-xs text-muted">
              {t('首包偏慢，多半在接口或网络这一侧：可以在「设置 › API」里测速，对比不同协议和链路')}
            </p>
          )}
        </div>
      )}
    </SessionCard>
  )
}

/** 最近几次首包的小条：高度按这几次里最长的那次归一，超过门槛的标黄 */
function Bars({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const top = Math.max(...values, 1)
  return (
    <div className="flex h-6 items-end gap-0.5" aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          title={fmtDuration(v)}
          className={cn('min-w-0 flex-1 rounded-sm', v >= SLOW_FIRST_TOKEN_MS ? 'bg-warning/70' : 'bg-accent/50')}
          style={{ height: `${Math.max(8, (v / top) * 100)}%` }}
        />
      ))}
    </div>
  )
}
