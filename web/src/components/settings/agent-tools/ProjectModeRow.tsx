import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { toolGatewayContract as G, type GatewaySettingsView } from '@shared/api-contract/tool-gateway'
import type { GatewayStats } from '@shared/tool-gateway/stats'
import type { GatewayMode } from '@shared/tool-gateway/types'
import { call } from '@/lib/api/call'
import { Select } from '@/components/ui/input'
import { Row } from '../parts'

/** 统计按这个项目最近这么多次调用算 */
const WINDOW = 300

/**
 * 「这个项目」的网关模式：跟随全局，或单独设。观察模式下攒够了搜索、改道能接的比例够高时，
 * 说明里提示可以给这个项目打开改道（用户 2026-11-26 定：统计达标后提示按项目打开，不全局一刀切）
 */
export function ProjectModeRow({
  projectId,
  settings,
  onSaved,
  onError,
}: {
  projectId: string
  settings: GatewaySettingsView
  onSaved: (s: GatewaySettingsView) => void
  onError: (msg: string) => void
}) {
  const [stats, setStats] = useState<GatewayStats>()
  useEffect(() => {
    setStats(undefined)
    call(G.stats, { query: { projectId, n: WINDOW } })
      .then(setStats)
      .catch(() => undefined)
  }, [projectId])
  const own = settings.projects[projectId] ?? ''
  const save = (v: string) =>
    call(G.setSettings, { body: { project: { id: projectId, mode: (v || null) as GatewayMode | null } } })
      .then(onSaved)
      .catch((e: Error) => onError(e.message))
  const tk = stats?.takeover
  const effective = own || settings.mode
  const desc = !tk?.searches
    ? t('这个项目最近还没有搜索类的调用，攒一阵再看改道能接多少')
    : tk.ready && effective !== 'enforce'
      ? t('最近 {n} 次搜索里改道能接 {m} 次，可以给这个项目打开改道了', { n: tk.searches, m: tk.would })
      : t('最近 {n} 次搜索里改道能接 {m} 次', { n: tk.searches, m: tk.would })
  return (
    <Row title={t('这个项目的模式')} desc={desc}>
      <Select
        aria-label={t('这个项目的模式')}
        value={own}
        onChange={(e) => void save(e.target.value)}
        options={[
          { value: '', label: t('跟随全局') },
          ...settings.modes.filter((m) => m.available).map((m) => ({ value: m.id, label: m.label })),
        ]}
      />
    </Row>
  )
}
