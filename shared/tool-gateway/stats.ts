/**
 * 调用记录的统计和筛选：服务端接口和演示后端调同一份（AGENTS.md：演示后端调用 shared 里的同一份逻辑）。
 *
 * 口径（设置「调用记录」页四张卡片）：
 * - 各决定数：最近 N 条（按时间倒序取）里每种实际决定各几次；
 * - 能改道：有 wouldRoute 的条数和占比（观察模式下只推算，没有真的改）；
 * - 推了技能：这 N 条里新推的技能次数、字数和 token，按对话合计；
 * - 本可以并行：标了 serial 的条数（判定见 isSerial）
 */
import { z } from 'zod'
import { CAPABILITY_IDS, GATEWAY_DECISIONS, type CallRecord } from './types.ts'

/**
 * 本可以并行：同一轮（同一次 CLI 调用）里，这一次和上一次都是只读调用，且上一次已经执行完（收到工具后）
 * 这一次才到达面板——说明模型是等上一个结果回来才发下一个，而这两个互不依赖、本可以放在同一条回复里一起发。
 * 中间夹着改文件、跑别的命令的不算（上一条就不是只读）；上一次还没收到工具后就来了的，算是一起发的。
 * 按工具前到达面板的顺序和时间判断，CLI 报不出工具后的（没有 durMs）一律不算
 */
export function isSerial(
  prev: Pick<CallRecord, 'readOnly' | 'at' | 'durMs' | 'turn'> | undefined,
  cur: Pick<CallRecord, 'readOnly' | 'at' | 'turn'>,
): boolean {
  if (!prev || !cur.readOnly || !prev.readOnly || prev.turn !== cur.turn || prev.durMs === undefined) return false
  return prev.at + prev.durMs <= cur.at
}

const Count = z.record(z.string(), z.number())

export const GatewayStats = z.object({
  /** 取了最近几条（请求的 N） */
  window: z.number(),
  /** 实际有几条 */
  total: z.number(),
  byDecision: Count,
  routable: z.number(),
  byCapability: Count,
  readOnly: z.number(),
  serial: z.number(),
  skills: z.object({
    count: z.number(),
    chars: z.number(),
    tokens: z.number(),
    byTask: z.array(
      z.object({ taskId: z.string(), title: z.string(), count: z.number(), chars: z.number(), tokens: z.number() }),
    ),
  }),
  errors: z.number(),
  /**
   * 网关自己多花的时间（毫秒；认调用 + 推算改道 + 记录，不含守卫、推送、用户钩子）：平均、中位数、P95、最慢一次（是哪条调用）。
   * hook 是整个工具前回答（守卫、钩子、网关合计）的中位数和 P95，两个对着看才知道网关占了多少
   */
  ms: z.object({
    avg: z.number(),
    median: z.number(),
    p95: z.number(),
    max: z.number(),
    slowest: z.object({ id: z.string(), tool: z.string(), summary: z.string(), ms: z.number() }).optional(),
    hook: z.object({ median: z.number(), p95: z.number() }),
  }),
})
export type GatewayStats = z.infer<typeof GatewayStats>

const round2 = (n: number) => Math.round(n * 100) / 100
/** 排好序的数取分位（最近秩）；空的为 0 */
const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : 0

/** records 新的在前；取前 n 条算 */
export function gatewayStats(records: CallRecord[], n: number): GatewayStats {
  const list = records.slice(0, n)
  const byDecision: Record<string, number> = Object.fromEntries(GATEWAY_DECISIONS.map((d) => [d, 0]))
  const byCapability: Record<string, number> = Object.fromEntries(CAPABILITY_IDS.map((c) => [c, 0]))
  const tasks = new Map<string, { taskId: string; title: string; count: number; chars: number; tokens: number }>()
  let routable = 0
  let readOnly = 0
  let serial = 0
  let errors = 0
  for (const r of list) {
    byDecision[r.decision]++
    if (r.wouldRoute) {
      routable++
      byCapability[r.wouldRoute.capability]++
    }
    if (r.readOnly) readOnly++
    if (r.serial) serial++
    if (r.error) errors++
    for (const s of r.skills ?? []) {
      const x = tasks.get(r.taskId) ?? { taskId: r.taskId, title: r.taskTitle, count: 0, chars: 0, tokens: 0 }
      x.count++
      x.chars += s.chars
      x.tokens += s.tokens
      tasks.set(r.taskId, x)
    }
  }
  const byTask = [...tasks.values()].sort((a, b) => b.tokens - a.tokens)
  const ms = list.map((r) => r.ms).sort((a, b) => a - b)
  const hook = list.flatMap((r) => (r.hookMs === undefined ? [] : [r.hookMs])).sort((a, b) => a - b)
  const slow = list.reduce<CallRecord | undefined>((a, r) => (!a || r.ms > a.ms ? r : a), undefined)
  return {
    window: n,
    total: list.length,
    byDecision,
    routable,
    byCapability,
    readOnly,
    serial,
    skills: {
      count: byTask.reduce((a, x) => a + x.count, 0),
      chars: byTask.reduce((a, x) => a + x.chars, 0),
      tokens: byTask.reduce((a, x) => a + x.tokens, 0),
      byTask,
    },
    errors,
    ms: {
      avg: ms.length ? round2(ms.reduce((a, x) => a + x, 0) / ms.length) : 0,
      median: round2(quantile(ms, 0.5)),
      p95: round2(quantile(ms, 0.95)),
      max: round2(ms.at(-1) ?? 0),
      ...(slow ? { slowest: { id: slow.id, tool: slow.tool, summary: slow.summary, ms: slow.ms } } : {}),
      hook: { median: round2(quantile(hook, 0.5)), p95: round2(quantile(hook, 0.95)) },
    },
  }
}

export interface CallQuery {
  taskId?: string
  decision?: string
  capability?: string
  /** 搜命令、工具名、路径（不分大小写） */
  q?: string
  offset?: number
  limit?: number
}

/** 筛选 + 分页；records 新的在前 */
export function filterCalls(records: CallRecord[], o: CallQuery): { items: CallRecord[]; total: number } {
  const q = o.q?.trim().toLowerCase()
  const hit = records.filter(
    (r) =>
      (!o.taskId || r.taskId === o.taskId) &&
      (!o.decision || r.decision === o.decision) &&
      (!o.capability || r.capability === o.capability || r.wouldRoute?.capability === o.capability) &&
      (!q || `${r.tool} ${r.summary}`.toLowerCase().includes(q)),
  )
  const offset = Math.max(0, o.offset ?? 0)
  const limit = Math.min(200, Math.max(1, o.limit ?? 50))
  return { items: hit.slice(offset, offset + limit), total: hit.length }
}
