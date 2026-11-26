/**
 * 能力路由的主流程（设计稿：统一查找方式 第 3.3、8.3 节）：按 rank 排好的几条路依次看能不能用，能用就查；
 * 「正在启动 / 建索引」且一分钟内能好的在这里等（ADR 0067 第 5 节：能等到的在工具里等到）；用不了、出错的跳过并记原因。
 * 结果怎么合由能力定：first 用第一条有结果的，union 把有结果的都并起来（查找要用文本补动态调用）。
 * 不按能力名写分支：新能力只给 sources 和 isFinal
 */
import type { CapabilityId, Readiness, RouteStep } from '../../shared/capability-router/types.ts'
import type { ToolRoute } from '../../shared/capability-router/tool-route.ts'
import { recordRoute } from './log.ts'

export interface RouteSource<Req, Out> {
  id: string
  /** 工具卡片上显示的名字和是外部 MCP 还是面板自带（ToolUse.route）；不给时显示 id、算面板自带 */
  label?: string
  via?: 'mcp' | 'panel'
  rank: number
  /** 这个请求它管不管（语言、种类对不上的不进记录） */
  accepts(req: Req): boolean
  ready(req: Req): Readiness | Promise<Readiness>
  run(req: Req, signal?: AbortSignal): Promise<Out>
}

export interface RouteOptions<Req, Out> {
  capability: CapabilityId
  projectId: string
  taskId?: string
  entry: string
  what: string
  req: Req
  sources: RouteSource<Req, Out>[]
  /** 这条路查回来算不算「没有」 */
  isEmpty(out: Out): boolean
  /** 有了这条路的结果后还要不要往下走（union 时用；first 时有结果就停） */
  enough(source: RouteSource<Req, Out>, out: Out): boolean
  signal?: AbortSignal
  /** 等「正在启动」的路最多等多久 */
  waitMs?: number
}

export interface RouteResult<Out> {
  outs: { source: string; out: Out }[]
  /** 跑了但没给结果的路的输出：结果为空也可能带说明（只查了一部分、超时），调用方要转告，不然「没有找到」像是查全了 */
  empties: { source: string; out: Out }[]
  steps: RouteStep[]
  ms: number
}

/** 路由结果换成工具卡片上的「实际走的路」（ToolUse.route）：名字和是不是 MCP 按 sources 上登记的 */
export function toolRouteOf(
  capability: CapabilityId,
  sources: RouteSource<never, unknown>[],
  r: RouteResult<unknown>,
): ToolRoute {
  const hop = (id: string) => {
    const s = sources.find((x) => x.id === id)
    return { source: id, label: s?.label ?? id, via: s?.via ?? ('panel' as const) }
  }
  return {
    capability,
    served: r.outs.map((x) => hop(x.source)),
    steps: r.steps.map((s) => ({
      ...hop(s.source),
      outcome: s.outcome,
      ...(s.why && { why: s.why }),
      ...(s.ms !== undefined && { ms: s.ms }),
    })),
    ms: r.ms,
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
  })

/** 等一条「正在启动」的路，直到能用、不行了，或超过 deadline */
async function waitReady<Req>(s: RouteSource<Req, unknown>, req: Req, deadline: number, signal?: AbortSignal) {
  let r: Readiness = await s.ready(req)
  while (r.state === 'starting' && Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(1000, Math.max(200, r.etaMs ?? 1000)), signal)
    r = await s.ready(req)
  }
  return r
}

export async function route<Req, Out>(o: RouteOptions<Req, Out>): Promise<RouteResult<Out>> {
  const t0 = Date.now()
  const steps: RouteStep[] = []
  const outs: { source: string; out: Out }[] = []
  const empties: { source: string; out: Out }[] = []
  const sources = o.sources.filter((s) => s.accepts(o.req)).sort((a, b) => a.rank - b.rank)
  const deadline = t0 + (o.waitMs ?? 60_000)
  for (const s of sources) {
    if (o.signal?.aborted) break
    const r = await waitReady(s, o.req, deadline, o.signal)
    if (r.state !== 'ready') {
      steps.push({ source: s.id, outcome: 'skipped', why: r.why })
      continue
    }
    const t1 = Date.now()
    try {
      const out = await s.run(o.req, o.signal)
      const empty = o.isEmpty(out)
      steps.push({ source: s.id, outcome: empty ? 'empty' : 'used', ms: Date.now() - t1 })
      if (empty) {
        empties.push({ source: s.id, out })
        continue
      }
      outs.push({ source: s.id, out })
      if (o.enough(s, out)) break
    } catch (e) {
      steps.push({ source: s.id, outcome: 'failed', why: (e as Error).message, ms: Date.now() - t1 })
    }
  }
  const ms = Date.now() - t0
  recordRoute({
    at: t0,
    capability: o.capability,
    projectId: o.projectId,
    ...(o.taskId && { taskId: o.taskId }),
    entry: o.entry,
    what: o.what,
    steps,
    ...(outs[0] && { served: outs.map((x) => x.source).join(' + ') }),
    ms,
  })
  return { outs, empties, steps, ms }
}
