import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { toolGatewayContract as G, type CallPage } from '@shared/api-contract/tool-gateway'
import type { GatewayStats } from '@shared/tool-gateway/stats'
import { CAPABILITY_IDS, GATEWAY_DECISIONS, type CallRecord } from '@shared/tool-gateway/types'
import { call } from '@/lib/api/call'
import { useData } from '@/lib/data'
import { useToolCallFeed } from '@/lib/live/tool-calls'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Select } from '@/components/ui/input'
import { SearchBox } from '@/components/ui/search-box'
import { CallStats } from './CallStats'
import { CallTable } from './CallTable'
import { DECISION_LOOKS, capabilityLabel } from './call-labels'

const PAGE = 50
/** 统计按最近这么多条算 */
const WINDOW = 200
/** 推送来得密时统计最多隔这么久重取一次（每次调用都重取太吵） */
const STATS_GAP_MS = 3000

interface Filters {
  projectId: string
  taskId: string
  decision: string
  capability: string
  q: string
}

/**
 * 「调用记录」页签：顶上搜索和筛选、四张统计卡，下面是表格。先按契约取一页，之后跟着推送（tool-call）把新记录插到最前、
 * 补上执行结果；有筛选时只更新已在表里的那几条（新的要不要显示由服务端的筛选说了算，点「刷新」再取）
 */
export function CallLogTab() {
  const { projects } = useData()
  const [f, setF] = useState<Filters>({ projectId: '', taskId: '', decision: '', capability: '', q: '' })
  const [page, setPage] = useState<CallPage>()
  const [stats, setStats] = useState<GatewayStats>()
  const [error, setError] = useState('')
  const statsTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = useCallback(
    (offset = 0) =>
      call(G.calls, { query: { ...f, offset, limit: PAGE } })
        .then((r) => setPage((cur) => (offset && cur ? { ...r, items: [...cur.items, ...r.items] } : r)))
        .catch((e: Error) => setError(e.message)),
    [f],
  )
  const loadStats = useCallback(
    () =>
      call(G.stats, { query: { projectId: f.projectId, n: WINDOW } })
        .then(setStats)
        .catch(() => undefined),
    [f.projectId],
  )
  useEffect(() => {
    void load(0)
  }, [load])
  useEffect(() => {
    void loadStats()
  }, [loadStats])
  useEffect(() => () => clearTimeout(statsTimer.current), [])

  const filtered = !!(f.taskId || f.decision || f.capability || f.q)
  useToolCallFeed((r: CallRecord) => {
    if (f.projectId && r.projectId !== f.projectId) return
    setPage((cur) => {
      if (!cur) return cur
      const at = cur.items.findIndex((x) => x.id === r.id)
      if (at >= 0) return { ...cur, items: cur.items.map((x, i) => (i === at ? r : x)) }
      if (filtered) return cur
      const tasks = cur.tasks.some((x) => x.id === r.taskId)
        ? cur.tasks
        : [{ id: r.taskId, title: r.taskTitle }, ...cur.tasks]
      return { ...cur, items: [r, ...cur.items], total: cur.total + 1, tasks }
    })
    if (!statsTimer.current)
      statsTimer.current = setTimeout(() => {
        statsTimer.current = undefined
        void loadStats()
      }, STATS_GAP_MS)
  })

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const all = (label: string) => ({ value: '', label })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-56 flex-1">
          <SearchBox placeholder={t('搜索命令或工具')} allowEmpty onSearch={(q) => setF((x) => ({ ...x, q }))} />
        </div>
        <Select
          size="sm"
          className="w-40"
          aria-label={t('项目')}
          value={f.projectId}
          onChange={set('projectId')}
          options={[all(t('全部项目')), ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <Select
          size="sm"
          className="w-40"
          aria-label={t('对话')}
          value={f.taskId}
          onChange={set('taskId')}
          options={[all(t('全部对话')), ...(page?.tasks ?? []).map((x) => ({ value: x.id, label: x.title || x.id }))]}
        />
        <Select
          size="sm"
          className="w-40"
          aria-label={t('决定')}
          value={f.decision}
          onChange={set('decision')}
          options={[
            all(t('全部决定')),
            ...GATEWAY_DECISIONS.map((d) => ({ value: d, label: DECISION_LOOKS[d].label() })),
          ]}
        />
        <Select
          size="sm"
          className="w-40"
          aria-label={t('能力')}
          value={f.capability}
          onChange={set('capability')}
          options={[all(t('全部能力')), ...CAPABILITY_IDS.map((c) => ({ value: c, label: capabilityLabel(c) }))]}
        />
      </div>
      <CallStats s={stats} />
      {error && <p className="text-body text-danger">{error}</p>}
      {page && !page.items.length ? (
        <EmptyPanel size="md">
          {filtered ? t('没有对得上的调用') : t('还没有工具调用记录：对话里 Agent 调用工具时，每一次都会记在这里')}
        </EmptyPanel>
      ) : (
        page && <CallTable items={page.items} />
      )}
      {page?.hasMore && (
        <Button
          variant="secondary"
          size="sm"
          className="w-fit self-center"
          onClick={() => void load(page.items.length)}
        >
          {t('再看 {n} 条', { n: Math.min(PAGE, page.total - page.items.length) })}
        </Button>
      )}
    </div>
  )
}
