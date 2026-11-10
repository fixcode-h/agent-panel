/**
 * 总览页的 Bug 视图（分析稿 B6）：用户报的 Bug 分散在各个父对话的子对话里，原来看不到现在有几个在查、
 * 各卡在哪一步、哪些在等你。这里把它们裁成精简的行（接口 GET /tasks/bugs 返回 bugBriefs 的结果），
 * 再按「等你处理 / 进行中 / 已结束」分组。
 * 状态只看报告的阶段、用户的决定和面板状态（taskState），不看回复文字（ADR 0041、0049）
 */
import type { BugLevel, BugPhase } from './bug-diagnosis-schema.ts'
import { phaseOf } from './bug-phase.ts'
import { BUG_PHASES, bugOutcome, bugRating, type BugDiag, type BugLike } from './bug-stats.ts'
import { observation } from './bug-observe.ts'
import { t } from './i18n.ts'
import type { Task } from './schema.ts'
import { taskDeleted, taskState, type ConvState } from './task.ts'

/** Bug 视图的一行要的字段：不带消息、不带整份报告，几百个 Bug 也只有几十 KB */
export interface BugBrief extends BugLike {
  bug: true
  title: string
  projectId: string
  parentTaskId: string
  /** 直接父对话的标题：行上写「项目 · 父对话」，知道是哪件事里报的 */
  parentTitle: string
  /** 点一行要打开的顶层对话；Bug 自己就是顶层对话时为空 */
  rootId: string
  /** 顶层对话右栏里要打开的子对话：Bug 自己，或它在顶层对话名下的那个祖先（多层子对话时） */
  paneId: string
  updatedAt: string
  /** 对话现在的状态，和侧栏、标题栏同一个口径（shared/task.ts 的 taskState），服务端按完整任务算好 */
  state: ConvState
  /** 自己或所属的顶层对话归档了：列表里不列，统计照算 */
  archived: boolean
  level: BugLevel
  diagnoses: BugDiag[]
  /** 偶发的 Bug 修好后的观察期到哪天（分析稿 B13，shared/bug-observe.ts）；不是偶发、还没修好的没有 */
  observeUntil?: string
  /** 观察期里又报了几次同类问题（面板按关键词自动关联的） */
  relapses?: number
}

const briefDiag = (d: NonNullable<Task['diagnoses']>[number]): BugDiag => ({
  version: d.version,
  rev: d.rev,
  phase: d.phase,
  confirmed: d.confirmed,
  at: d.at,
  status: d.status,
  level: d.level,
  decidedAt: d.decidedAt,
  awaiting: d.awaiting ? { at: d.awaiting.at } : undefined,
  rating: d.rating ? { tier: d.rating.tier, percent: d.rating.percent } : undefined,
  cleanup: d.cleanup ? { state: d.cleanup.state } : undefined,
})

/**
 * 所有用户报的 Bug（含子对话）裁成精简行。tasks 传全部任务（要靠它找父对话的标题和顶层对话）；
 * 进了回收站的不列（自己或顶层对话被删都算）
 */
export function bugBriefs(tasks: Task[]): BugBrief[] {
  const byId = new Map(tasks.map((x) => [x.id, x]))
  const out: BugBrief[] = []
  for (const tk of tasks) {
    if (!tk.bug || taskDeleted(tk)) continue
    // 往上找到顶层对话，记下它名下的那一层：对话页只能在顶层对话的右栏里打开它的直接子对话
    let root = tk
    let pane = tk
    const seen = new Set([tk.id])
    for (;;) {
      const up = byId.get(root.parentTaskId ?? '')
      if (!up || seen.has(up.id)) break
      seen.add(up.id)
      pane = root
      root = up
    }
    if (taskDeleted(root)) continue
    const list = tk.diagnoses ?? []
    out.push({
      id: tk.id,
      bug: true,
      title: tk.title,
      projectId: tk.projectId,
      parentTaskId: tk.parentTaskId ?? '',
      parentTitle: byId.get(tk.parentTaskId ?? '')?.title ?? '',
      rootId: root.id === tk.id ? '' : root.id,
      paneId: pane.id,
      createdAt: tk.createdAt,
      updatedAt: tk.updatedAt,
      state: taskState(tk),
      resolved: !!tk.resolved,
      archived: !!tk.archived || !!root.archived,
      level: list.at(-1)?.level ?? tk.bugCase?.level ?? 'standard',
      diagnoses: list.map(briefDiag),
      observeUntil: observation(tk)?.until,
      relapses: tk.bugCase?.relapses?.length || undefined,
    })
  }
  return out
}

/** you：等你处理；active：进行中；ended：已结束（修好了或不修了） */
export type BugGroup = 'you' | 'active' | 'ended'

export const BUG_GROUPS: BugGroup[] = ['you', 'active', 'ended']

/**
 * 现在等谁：confirm 等你确认这一版；repro 日志加好了等你复现；verify 等你验证；reply 它问了问题等你回复；
 * failed 执行失败了；analyzing 它在分析；cleaning 不修了、它在删临时日志；idle 没在执行（没人在等、也没人在做）；
 * fixed 已修好；cancelled 已取消；observing 偶发的修好了、在观察期里；relapsed 观察期里又报了同类问题，等你决定要不要重开
 */
export type BugWho =
  | 'confirm'
  | 'repro'
  | 'verify'
  | 'reply'
  | 'failed'
  | 'analyzing'
  | 'cleaning'
  | 'idle'
  | 'fixed'
  | 'cancelled'
  | 'observing'
  | 'relapsed'

const WHO_GROUP: Record<BugWho, BugGroup> = {
  confirm: 'you',
  repro: 'you',
  verify: 'you',
  reply: 'you',
  failed: 'you',
  relapsed: 'you',
  analyzing: 'active',
  observing: 'active',
  cleaning: 'active',
  idle: 'active',
  fixed: 'ended',
  cancelled: 'ended',
}

/** 「现在等谁」在界面上的说法：前三个和子对话行上的阶段（bugStage）同一个词 */
export const bugWhoText = (who: BugWho): string =>
  ({
    confirm: t('等你确认'),
    repro: t('等你复现'),
    verify: t('等你验证'),
    reply: t('等你回复'),
    failed: t('失败'),
    analyzing: t('它在分析'),
    cleaning: t('它在删临时日志'),
    idle: t('没在执行'),
    fixed: t('已修好'),
    cancelled: t('已取消'),
    observing: t('观察中'),
    relapsed: t('又出现了'),
  })[who]

export const bugLevelText = (level: BugLevel): string =>
  ({ quick: t('快速'), standard: t('标准'), deep: t('深入') })[level]

/** 五步的名字，顺序和 BUG_PHASES 一致（诊断报告弹窗的阶段条是同一组词） */
export const bugPhaseText = (p: BugPhase): string =>
  ({ evidence: t('论证'), cause: t('根因'), plan: t('修复方案'), fix: t('修复'), verify: t('验证') })[p]

export function bugWho(b: BugBrief, now = new Date().toISOString()): BugWho {
  const d = b.diagnoses.at(-1)
  if (d?.status === 'cancelled') {
    // 不修了但临时日志还没删完：它在删，或者核对没过在等你决定怎么办
    if (d.cleanup?.state === 'running') return 'cleaning'
    return d.cleanup?.state === 'failed' ? 'confirm' : 'cancelled'
  }
  // 偶发的修好了还在观察期里：没到「已结束」，观察期里又报了同类的提到「等你处理」，提示重开
  const fixed = b.resolved || bugOutcome(b) === 'fixed'
  if (fixed && b.observeUntil && b.observeUntil > now) return b.relapses ? 'relapsed' : 'observing'
  if (b.resolved) return 'fixed'
  if (d?.status === 'pending') return d.awaiting ? 'repro' : phaseOf(d) === 'verify' ? 'verify' : 'confirm'
  if (bugOutcome(b) === 'fixed') return 'fixed'
  if (b.state === 'needs') return 'reply'
  if (b.state === 'failed') return 'failed'
  return b.state === 'running' || b.state === 'waiting' ? 'analyzing' : 'idle'
}

/**
 * 现在在五步里的第几步（0–4，5 是五步都走完了）：它之前的都做完了。
 * 和诊断报告弹窗的阶段条（DiagnosisStages）同一个算法：根因同意了到方案，方案确认了到修复，修复确认了到验证，
 * 验证点了结束才算走完；还没交过报告的在论证
 */
export function bugStep(list: BugDiag[]): number {
  const d = list.at(-1)
  if (!d) return 0
  const i = BUG_PHASES.indexOf(phaseOf(d))
  if (i === 0) return 0
  return d.status === 'approved' ? i + 1 : i
}

/** 停在这一步的起点：最后一份报告上最晚的那个时间（交上来、请你复现、你做了决定）；还没交过报告就是立案的时间 */
export function bugSince(b: BugLike): string {
  const d = b.diagnoses?.at(-1)
  if (!d) return b.createdAt
  return [d.at, d.awaiting?.at, d.decidedAt].filter((x): x is string => !!x).reduce((a, x) => (x > a ? x : a))
}

export interface BugRow {
  bug: BugBrief
  group: BugGroup
  who: BugWho
  step: number
  /** 论证了几轮：停在论证时写在进度旁边 */
  rounds: number
  rating?: BugDiag['rating']
  since: string
}

/** 分好组的行：等你处理的在最上面，然后进行中，然后已结束；组内等得最久的在前（已结束的最近结束的在前）。归档的不列 */
export function bugRows(briefs: BugBrief[], now = new Date().toISOString()): BugRow[] {
  const rows = briefs
    .filter((b) => !b.archived)
    .map((b): BugRow => {
      const who = bugWho(b, now)
      return {
        bug: b,
        group: WHO_GROUP[who],
        who,
        step: bugStep(b.diagnoses),
        rounds: b.diagnoses.filter((d) => phaseOf(d) === 'evidence').length,
        rating: bugRating(b.diagnoses),
        since: bugSince(b),
      }
    })
  return rows.sort(
    (a, b) =>
      BUG_GROUPS.indexOf(a.group) - BUG_GROUPS.indexOf(b.group) ||
      (a.group === 'ended' ? b.since.localeCompare(a.since) : a.since.localeCompare(b.since)),
  )
}
