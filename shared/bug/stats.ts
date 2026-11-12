/**
 * Bug 流程的数据（分析稿 B7）：这套「论证 → 根因 → 修复方案 → 修复 → 验证」的流程有没有用，原来没有任何统计。
 * 这里只读任务上已有的记录（各版报告的 at、用户决定的时间 decidedAt、状态）算数，不改任何流程行为；
 * 状态只看报告的阶段和用户的决定，不看回复文字（ADR 0041、0049）。总览页的 Bug 视图顶上显示汇总
 */
import type { BugPhase, BugRating, Diagnosis } from './diagnosis-schema.ts'
import { phaseOf } from './phase.ts'

/**
 * 统计和 Bug 视图用到的那几项报告字段：列表接口不带整份报告（一份几十 KB），
 * 服务端按这个形状裁（shared/bug/overview.ts 的 bugBriefs），完整的 Diagnosis 也能直接传进来
 */
export type BugDiag = Pick<Diagnosis, 'version' | 'at' | 'status'> & {
  phase?: BugPhase
  confirmed: boolean
  rev?: number
  level?: Diagnosis['level']
  decidedAt?: string
  awaiting?: { at: string }
  rating?: Pick<BugRating, 'tier' | 'percent'>
  cleanup?: { state: 'running' | 'done' | 'failed' | 'skipped' }
}

/** 算统计要的任务字段：完整任务和精简的 Bug 行都满足 */
export interface BugLike {
  id: string
  bug?: boolean
  createdAt: string
  /** 子对话标了「已解决」：父对话收尾合并后的标记，没走到验证也算修好了 */
  resolved?: boolean
  diagnoses?: BugDiag[]
}

export const BUG_PHASES: BugPhase[] = ['evidence', 'cause', 'plan', 'fix', 'verify']

export type BugTier = BugRating['tier']

/** open：还在查或在修；fixed：修好了；cancelled：用户点了不修了 */
export type BugOutcome = 'open' | 'fixed' | 'cancelled'

/**
 * 这个 Bug 的结局：最后一版被取消是不修了；标了已解决、或用户在验证那一版点了结束是修好了。
 * 验证那一版用户只是贴了结果（answered）还不算：它分析完可能回到论证
 */
export function bugOutcome(b: BugLike): BugOutcome {
  const d = b.diagnoses?.at(-1)
  if (d?.status === 'cancelled') return 'cancelled'
  if (b.resolved) return 'fixed'
  return d && phaseOf(d) === 'verify' && d.status === 'approved' ? 'fixed' : 'open'
}

/**
 * 这一版被用户带着意见退回过。退回的那一版在新一版交上来后会被改成 superseded（submitDiagnosis），
 * 所以还要认「被顶掉、但用户做过决定」的：只是没等到决定就被顶掉的没有 decidedAt；
 * 同意加日志后在等复现时被顶掉的有 decidedAt 也有 awaiting，那是同意不是退回
 */
export const wasQuestioned = (d: BugDiag) =>
  d.status === 'questioned' || (d.status === 'superseded' && !!d.decidedAt && !d.awaiting)

/** 最新一版带根因评级的报告的评级（论证阶段还没有根因，不算） */
export function bugRating(list: BugDiag[] | undefined): BugDiag['rating'] {
  return [...(list ?? [])].reverse().find((d) => d.rating && phaseOf(d) !== 'evidence')?.rating
}

const ms = (iso: string | undefined) => {
  const n = iso ? new Date(iso).getTime() : NaN
  return Number.isFinite(n) ? n : undefined
}

/** 一个 Bug 的流程数据 */
export interface BugMetrics {
  id: string
  outcome: BugOutcome
  /** 交过几份报告 */
  reports: number
  /** 论证了几轮（论证阶段的报告份数，和子对话行上「论证 · 第 n 轮」同一个数） */
  evidenceRounds: number
  /** 被用户否决 / 提疑问的次数：论证、根因、方案、修复这几步被带着意见退回的份数（验证没通过的另算） */
  questioned: number
  /** 验证没通过的次数：验证那一版被退回，或者之后又回到论证、根因、方案 */
  verifyFailed: number
  /** 结论被推翻、回到论证的次数（根因被否决、验证没过之后重新论证） */
  reopened: number
  /** 用户经手了几次：同意、退回、贴日志各算一次；同意加日志后再贴日志是两次 */
  decisions: number
  /** 一次修好：修好了，而且没有被否决、没有验证失败、没有回到论证 */
  firstTry: boolean
  /** 从立案（对话创建）到结束的毫秒数；没结束、或结束的时间没记下就没有 */
  totalMs?: number
  /** 各阶段停留的毫秒数：一份报告从交上来到下一份交上来（最后一份到结束）算在它那个阶段；第一份报告之前算论证 */
  phaseMs: Partial<Record<BugPhase, number>>
  tier?: BugTier
}

export function bugMetrics(b: BugLike): BugMetrics {
  const list = b.diagnoses ?? []
  const last = list.at(-1)
  const outcome = bugOutcome(b)
  const phases = list.map((d) => phaseOf(d))
  const early = (p: BugPhase | undefined) => p === 'evidence' || p === 'cause' || p === 'plan'
  let questioned = 0
  let verifyFailed = 0
  let reopened = 0
  let decisions = 0
  list.forEach((d, i) => {
    if (phases[i] === 'verify') {
      if (wasQuestioned(d) || early(phases[i + 1])) verifyFailed++
    } else if (wasQuestioned(d)) questioned++
    if (i > 0 && phases[i] === 'evidence' && phases[i - 1] !== 'evidence') reopened++
    if (d.decidedAt && d.status !== 'cancelled') decisions++
    // 同意加日志（记了 decidedAt）之后又贴了日志：decidedAt 被贴日志的时间盖掉了，补上同意的那一次
    if (d.status === 'answered' && d.awaiting) decisions++
  })

  // 结束的时间只认用户最后一次决定（取消、结束验证）；标了已解决但没记决定时间的不估
  const endAt = outcome === 'open' ? undefined : ms(last?.decidedAt)
  const start = ms(b.createdAt)
  const phaseMs: BugMetrics['phaseMs'] = {}
  const add = (p: BugPhase, from: number | undefined, to: number | undefined) => {
    if (from === undefined || to === undefined || to < from) return
    phaseMs[p] = (phaseMs[p] ?? 0) + (to - from)
  }
  if (list.length) add('evidence', start, ms(list[0].at))
  list.forEach((d, i) => add(phases[i], ms(d.at), i + 1 < list.length ? ms(list[i + 1].at) : endAt))

  return {
    id: b.id,
    outcome,
    reports: list.length,
    evidenceRounds: phases.filter((p) => p === 'evidence').length,
    questioned,
    verifyFailed,
    reopened,
    decisions,
    firstTry: outcome === 'fixed' && !questioned && !verifyFailed && !reopened,
    totalMs: start !== undefined && endAt !== undefined && endAt >= start ? endAt - start : undefined,
    phaseMs,
    tier: bugRating(list)?.tier,
  }
}

/** 所有 Bug 的汇总。比例和平均值在没有样本时是 undefined，界面画成「—」，不写 0 让人误会 */
export interface BugSummary {
  total: number
  open: number
  fixed: number
  cancelled: number
  /** 一次修好的个数和它占修好的比例（0–1） */
  firstTry: number
  firstTryRate?: number
  /** 下面两个平均只算交过报告的 Bug：刚立案的还没有数可算 */
  avgDecisions?: number
  avgEvidenceRounds?: number
  /** 立案到结束的平均时长：只算记下了结束时间的 */
  avgTotalMs?: number
  /** 各阶段平均停留：只算在那个阶段停过的 Bug */
  avgPhaseMs: Partial<Record<BugPhase, number>>
  /** 按根因等级的数量：没评级的不算 */
  tiers: Record<BugTier, number>
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined)

/**
 * Bug 流程数据：每个 Bug 一行，加一份汇总。只统计标了 bug 的对话（用户报的 Bug），
 * 传完整任务或精简行都行；回收站里的由调用方先排掉
 */
export function bugStats(tasks: BugLike[]): { bugs: BugMetrics[]; summary: BugSummary } {
  const bugs = tasks.filter((x) => x.bug).map(bugMetrics)
  const fixed = bugs.filter((x) => x.outcome === 'fixed')
  const reported = bugs.filter((x) => x.reports > 0)
  const firstTry = fixed.filter((x) => x.firstTry).length
  const avgPhaseMs: BugSummary['avgPhaseMs'] = {}
  for (const p of BUG_PHASES) {
    const v = avg(bugs.flatMap((x) => (x.phaseMs[p] === undefined ? [] : [x.phaseMs[p]])))
    if (v !== undefined) avgPhaseMs[p] = v
  }
  const tiers: BugSummary['tiers'] = { low: 0, mid: 0, high: 0 }
  for (const x of bugs) if (x.tier) tiers[x.tier]++
  return {
    bugs,
    summary: {
      total: bugs.length,
      open: bugs.filter((x) => x.outcome === 'open').length,
      fixed: fixed.length,
      cancelled: bugs.filter((x) => x.outcome === 'cancelled').length,
      firstTry,
      firstTryRate: fixed.length ? firstTry / fixed.length : undefined,
      avgDecisions: avg(reported.map((x) => x.decisions)),
      avgEvidenceRounds: avg(reported.map((x) => x.evidenceRounds)),
      avgTotalMs: avg(bugs.flatMap((x) => (x.totalMs === undefined ? [] : [x.totalMs]))),
      avgPhaseMs,
      tiers,
    },
  }
}
