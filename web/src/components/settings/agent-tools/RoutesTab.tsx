import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import {
  toolGatewayContract as G,
  type CapabilityView,
  type GatewaySettingsView,
} from '@shared/api-contract/tool-gateway'
import type { GatewayMode } from '@shared/tool-gateway/types'
import { getCli } from '@shared/clis'
import { call } from '@/lib/api/call'
import { useData } from '@/lib/data'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Select } from '@/components/ui/input'
import { Group, Row } from '../parts'

const STATE_LOOK: Record<
  CapabilityView['routes'][number]['state'],
  { tone: 'success' | 'warning' | 'muted'; label: () => string }
> = {
  ready: { tone: 'success', label: () => t('已就绪') },
  starting: { tone: 'warning', label: () => t('准备中') },
  down: { tone: 'muted', label: () => t('用不了') },
  planned: { tone: 'muted', label: () => t('还没接上') },
}

const PARALLEL_LABEL: Record<string, () => string> = {
  yes: () => t('支持'),
  no: () => t('不支持'),
  unknown: () => t('没实测'),
}

/**
 * 「工具路由」页签（最小版）：网关模式（关闭 / 观察）、能力表只读显示接管哪些调用和各条路的状态，
 * 以及各 CLI 支不支持一条回复里发几个调用。改道、拖动排序、停用某条路第二期再做
 */
export function RoutesTab() {
  const { projects, clis } = useData()
  const [settings, setSettings] = useState<GatewaySettingsView>()
  const [caps, setCaps] = useState<CapabilityView[]>()
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [error, setError] = useState('')
  useEffect(() => {
    call(G.settings)
      .then(setSettings)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    setCaps(undefined)
    call(G.capabilities, { query: { projectId } })
      .then(setCaps)
      .catch((e: Error) => setError(e.message))
  }, [projectId])
  const setMode = (mode: string) =>
    call(G.setSettings, { body: { mode: mode as GatewayMode } })
      .then(setSettings)
      .catch((e: Error) => setError(e.message))
  const cur = settings?.modes.find((m) => m.id === settings.mode)
  return (
    <div className="flex flex-col">
      <p className="rounded-lg bg-sel/60 px-4 py-3 text-body text-muted">
        {t(
          '所有 Agent 的工具调用都先过面板。同一件事有几条路时，面板按下面的顺序和各条路现在的状态选；选不准的原样放行，出错也放行。',
        )}
      </p>
      {error && <p className="pt-2 text-body text-danger">{error}</p>}
      <Group title={t('网关')}>
        <Row title={t('改道')} desc={cur?.hint}>
          <Select
            aria-label={t('改道')}
            value={settings?.mode ?? ''}
            onChange={(e) => void setMode(e.target.value)}
            options={(settings?.modes ?? []).filter((m) => m.available).map((m) => ({ value: m.id, label: m.label }))}
          />
        </Row>
        <Row title={t('看哪个项目的路')} desc={t('查找的几条路按项目接的服务和插件算')}>
          <Select
            aria-label={t('项目')}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            options={[{ value: '', label: t('不选项目') }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </Row>
      </Group>
      {(caps ?? []).map((c) => (
        <Group
          key={c.id}
          title={`${c.label} · ${c.id}`}
          aside={c.phase > 1 ? <span className="font-normal">{t('第 {n} 期改道', { n: c.phase })}</span> : undefined}
        >
          <div className="flex flex-col gap-2 py-3.5">
            <span className="text-body text-muted">{c.summary}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-footnote text-subtle">
              {t('接管：')}
              {c.takes.map((x) => (
                <Badge key={x} className="font-mono">
                  {x}
                </Badge>
              ))}
            </span>
            <span className="text-footnote text-subtle">
              {t('最近的调用里归它 {n} 次，打开改道后能改走 {m} 次', { n: c.calls, m: c.routable })}
            </span>
          </div>
          {c.routes.map((r, i) => (
            <div key={r.id} className="flex items-center gap-3 border-t py-2.5 text-body">
              <span className="w-5 text-right font-mono text-footnote text-subtle">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={r.label}>
                {r.label}
              </span>
              <span className="shrink-0" title={r.why}>
                <StatusDot tone={STATE_LOOK[r.state].tone} label={r.why ?? STATE_LOOK[r.state].label()} compact />
              </span>
            </div>
          ))}
          {!c.routes.length && (
            <div className="border-t py-2.5 text-footnote text-subtle">{t('选一个项目看这个能力的几条路')}</div>
          )}
        </Group>
      ))}
      <Group title={t('各 CLI 能做到哪一步')}>
        {clis.map((c) => (
          <Row key={c.id} title={c.name} desc={t('一条回复里发几个工具调用')}>
            <span className="text-body text-muted">{PARALLEL_LABEL[getCli(c.id)?.parallelTools ?? 'unknown']()}</span>
          </Row>
        ))}
      </Group>
    </div>
  )
}
