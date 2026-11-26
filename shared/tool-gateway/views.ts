/**
 * 设置页要的几份视图：服务端接口和演示后端调同一份（演示只另给「几条路的状态」，那是本机才有的事实）
 */
import { CAPABILITIES } from '../capability-router/capabilities.ts'
import type { CapabilityId } from '../capability-router/types.ts'
import type { CallPage, CapabilityView, GatewaySettingsView } from '../api-contract/tool-gateway.ts'
import { filterCalls, type CallQuery } from './stats.ts'
import { GATEWAY_MODE_DEFS, type CallRecord, type GatewayMode } from './types.ts'

export const settingsView = (mode: GatewayMode): GatewaySettingsView => ({
  mode,
  modes: GATEWAY_MODE_DEFS.map((m) => ({ id: m.id, label: m.label(), hint: m.hint(), available: m.available })),
})

/** 能力表：几条路由调用方给（routes），其余按注册表和最近的记录算 */
export function capabilityViews(
  records: CallRecord[],
  routes: (id: CapabilityId) => CapabilityView['routes'],
): CapabilityView[] {
  return CAPABILITIES.map((c) => ({
    id: c.id,
    label: c.label(),
    summary: c.summary(),
    takes: c.takes,
    phase: c.phase,
    routes: routes(c.id),
    calls: records.filter((r) => r.capability === c.id).length,
    routable: records.filter((r) => r.wouldRoute?.capability === c.id).length,
  }))
}

/** 列调用记录：筛选、分页，附上记录里出现过的对话 */
export function callPage(records: CallRecord[], q: CallQuery): CallPage {
  const { items, total } = filterCalls(records, q)
  const offset = Math.max(0, q.offset ?? 0)
  const seen = new Map<string, string>()
  for (const r of records) if (!seen.has(r.taskId)) seen.set(r.taskId, r.taskTitle)
  return {
    items,
    total,
    offset,
    hasMore: offset + items.length < total,
    tasks: [...seen].map(([id, title]) => ({ id, title })),
  }
}

/** 查询参数 → CallQuery（服务端和演示后端同一份读法） */
export function callQueryOf(get: (k: string) => string | undefined | null): CallQuery {
  const num = (k: string) => {
    const v = Number(get(k))
    return Number.isFinite(v) && get(k) ? v : undefined
  }
  return {
    taskId: get('taskId') || undefined,
    decision: get('decision') || undefined,
    capability: get('capability') || undefined,
    q: get('q') || undefined,
    offset: num('offset'),
    limit: num('limit'),
  }
}
