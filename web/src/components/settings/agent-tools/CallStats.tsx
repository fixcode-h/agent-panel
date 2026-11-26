import { Gauge, ListChecks, Route, Rows3, Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import type { GatewayStats } from '@shared/tool-gateway/stats'
import { GATEWAY_DECISIONS } from '@shared/tool-gateway/types'
import { StatTile } from '@/components/ui/stat-tile'
import { DECISION_LOOKS } from './call-labels'

/** 调用记录页顶上的统计卡（四张口径卡加网关自身耗时）：口径见 shared/tool-gateway/stats.ts */
export function CallStats({ s }: { s: GatewayStats | undefined }) {
  const total = s?.total ?? 0
  const decisions = GATEWAY_DECISIONS.filter((d) => (s?.byDecision[d] ?? 0) > 0)
    .map((d) => `${DECISION_LOOKS[d].label()} ${s!.byDecision[d]}`)
    .join(' · ')
  const pct = total ? Math.round(((s?.routable ?? 0) / total) * 100) : 0
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <StatTile
        icon={ListChecks}
        tile="bg-sel text-muted"
        label={t('最近 {n} 次', { n: total })}
        value={String(total)}
        short={decisions || t('还没有调用')}
        note={t('最近 {n} 次工具调用里，面板各种决定的次数（观察模式下只有放行和拒绝）', { n: total })}
        dim={!total}
      />
      <StatTile
        icon={Route}
        tile="bg-accent-soft text-accent-text"
        label={t('能改道（观察中）')}
        value={t('{n} 次', { n: s?.routable ?? 0 })}
        short={`${pct}%`}
        note={t('打开改道后会改走别的路的调用：按能力表推算，观察模式下没有真的改')}
        dim={!s?.routable}
      />
      <StatTile
        icon={Sparkles}
        tile="bg-success/12 text-success"
        label={t('推了技能')}
        value={t('{n} 次', { n: s?.skills.count ?? 0 })}
        short={t('共 {n} token', { n: s?.skills.tokens ?? 0 })}
        note={t('这些调用前后面板新推的技能次数和估算的 token，按对话合计')}
        dim={!s?.skills.count}
      />
      <StatTile
        icon={Rows3}
        tile="bg-warning/12 text-warning"
        label={t('本可以并行')}
        value={t('{n} 次', { n: s?.serial ?? 0 })}
        short={t('只读调用 {n} 次里一个一个调的', { n: s?.readOnly ?? 0 })}
        note={t(
          '同一轮里上一个只读调用（读文件、搜索）执行完才发下一个，中间没有改文件或跑别的命令：这两个本可以放在同一条回复里一起发',
        )}
        dim={!s?.serial}
      />
      <StatTile
        icon={Gauge}
        tile="bg-sel text-muted"
        label={t('网关自身耗时')}
        value={t('中位 {n}ms', { n: s?.ms.median ?? 0 })}
        short={t('P95 {p}ms · 最慢 {m}ms', { p: s?.ms.p95 ?? 0, m: s?.ms.max ?? 0 })}
        note={t(
          '网关自己多花的时间：认调用、推算改道、记录，不含守卫和钩子。整个工具前回答中位 {h}ms、P95 {hp}ms。最慢一次：{slow}',
          {
            h: s?.ms.hook.median ?? 0,
            hp: s?.ms.hook.p95 ?? 0,
            slow: s?.ms.slowest ? `${s.ms.slowest.tool} ${s.ms.slowest.summary}（${s.ms.slowest.ms}ms）` : '—',
          },
        )}
        dim={!total}
      />
    </div>
  )
}
