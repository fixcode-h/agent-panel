import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { mcpProxyContract as P, type ExposureView } from '@shared/api-contract/mcp-proxy'
import { EXPOSURE_WHY_TEXT, type ExposureRun, type ServerExposure } from '@shared/mcp-proxy/types'
import { getCli } from '@shared/clis'
import { call } from '@/lib/api/call'
import { timeAgo } from '@shared/task'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from '../parts'

/**
 * 「工具路由」页签下面的「给 Agent 的工具」（ADR 0085）：代理开关；每个 CLI 最近一次开跑时每个外部服务是代理的还是直接挂的、为什么；
 * 代理的服务里哪些工具被能力接管、没给 Agent、该改用哪个。数据是真实开跑时记下的，不在这里去连外部服务
 */
export function ExposureGroup({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ExposureView>()
  const [error, setError] = useState('')
  useEffect(() => {
    call(P.exposure, { query: { projectId } })
      .then(setView)
      .catch((e: Error) => setError(e.message))
  }, [projectId])
  const toggle = (enabled: boolean) =>
    call(P.setSettings, { body: { enabled } })
      .then((r) => setView((v) => v && { ...v, enabled: r.enabled }))
      .catch((e: Error) => setError(e.message))
  const claimed = view?.claims.flatMap((c) => c.tools.map((x) => ({ tool: x, use: c.use, by: c.by }))) ?? []
  return (
    <Group title={t('给 Agent 的工具')}>
      <Row
        title={t('外部服务经面板代理')}
        desc={t(
          '开着时 CLI 只挂面板一个服务，项目和全局配置里的外部服务由面板代为调用，每次调用都进调用记录；代理不了的照旧直接挂',
        )}
      >
        <Switch checked={view?.enabled ?? true} onCheckedChange={toggle} aria-label={t('外部服务经面板代理')} />
      </Row>
      {error && <p className="py-2 text-body text-danger">{error}</p>}
      {(view?.runs ?? []).map((r) => (
        <RunRows key={`${r.projectId}-${r.cli}`} run={r} />
      ))}
      {view && !view.runs.length && (
        <div className="border-t py-2.5 text-footnote text-subtle">
          {t('这个项目还没有对话开跑过：开跑时面板按这个 CLI 会挂的外部服务算一遍，记在这里')}
        </div>
      )}
      {!!claimed.length && (
        <div className="flex flex-col gap-1.5 border-t py-3 text-footnote text-subtle">
          <span>{t('被能力接管、代理时不给 Agent 的外部工具（查找一律用面板的 find）：')}</span>
          <span className="flex flex-wrap gap-1.5">
            {claimed.map((c) => (
              <Badge key={c.tool} className="font-mono" title={t('改用 {use} · 登记：{by}', c)}>
                {c.tool}
              </Badge>
            ))}
          </span>
        </div>
      )}
    </Group>
  )
}

function RunRows({ run }: { run: ExposureRun }) {
  const name = getCli(run.cli)?.name ?? run.cli
  return (
    <div data-exposure-run={run.cli} className="flex flex-col border-t py-2.5">
      <span className="flex items-center gap-2 text-body">
        <span className="font-medium">{name}</span>
        <span className="min-w-0 truncate text-footnote text-subtle" title={run.taskTitle}>
          {t('{when}开跑 · {title}', { when: timeAgo(new Date(run.at).toISOString()), title: run.taskTitle || '—' })}
        </span>
      </span>
      {run.plan.servers.map((s) => (
        <ServerLine key={s.name} s={s} />
      ))}
      {!run.plan.servers.length && <span className="pt-1 text-footnote text-subtle">{t('没有外部服务')}</span>}
    </div>
  )
}

function ServerLine({ s }: { s: ServerExposure }) {
  const hidden = s.tools.filter((x) => !x.shown)
  const shown = s.tools.length - hidden.length
  return (
    <div data-exposure-server={s.name} className="flex flex-col gap-1 pt-2 pl-4">
      <span className="flex min-w-0 items-center gap-2 text-body">
        <span className="font-mono">{s.name}</span>
        <Badge tone={s.mode === 'proxy' ? 'success' : 'neutral'}>{s.mode === 'proxy' ? t('代理') : t('直接挂')}</Badge>
        <span className="min-w-0 truncate text-footnote text-subtle" title={s.source}>
          {s.source}
        </span>
        {s.mode === 'proxy' && (
          <span className="ml-auto shrink-0 text-footnote text-subtle tabular-nums">
            {t('给了 {n} 个工具', { n: shown })}
          </span>
        )}
      </span>
      <span className="text-footnote text-subtle" title={s.detail}>
        {EXPOSURE_WHY_TEXT[s.why]()}
        {s.detail ? `（${s.detail}）` : ''}
      </span>
      {!!hidden.length && (
        <span className="flex flex-wrap items-center gap-1.5 text-footnote text-subtle">
          {t('没给：')}
          {hidden.map((x) => (
            <Badge
              key={x.name}
              tone="warning"
              className="font-mono"
              title={t('改用 {use}', { use: x.hiddenBy?.use ?? '' })}
            >
              {x.name} → {x.hiddenBy?.use}
            </Badge>
          ))}
        </span>
      )}
    </div>
  )
}
