import assert from 'node:assert/strict'
import test from 'node:test'
import { bugMetrics, bugStats, type BugDiag, type BugLike } from './bug-stats.ts'

const MIN = 60_000
/** 立案后第 n 分钟 */
const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 8, 0) + n * MIN).toISOString()

let seq = 0
const diag = (
  phase: BugDiag['phase'],
  status: BugDiag['status'],
  min: number,
  more: Partial<BugDiag> = {},
): BugDiag => ({
  version: ++seq,
  phase,
  confirmed: phase !== 'evidence',
  at: at(min),
  status,
  // 用户做过决定的默认 5 分钟后决定；还在等的、没等到决定就被顶掉的没有
  decidedAt: status === 'pending' || status === 'superseded' ? undefined : at(min + 5),
  ...more,
})
const bug = (id: string, diagnoses: BugDiag[], more: Partial<BugLike> = {}): BugLike => ({
  id,
  bug: true,
  createdAt: at(0),
  diagnoses,
  ...more,
})

/** 一路顺下来：论证一轮（同意加日志、贴日志）→ 根因 → 方案 → 修复 → 验证点结束 */
const smooth = () =>
  bug('smooth', [
    diag('evidence', 'answered', 10, { awaiting: { at: at(20) }, decidedAt: at(30) }),
    diag('cause', 'approved', 40, { rating: { tier: 'low', percent: 90 } }),
    diag('plan', 'approved', 50),
    diag('fix', 'approved', 70),
    diag('verify', 'approved', 80, { decidedAt: at(100) }),
  ])

test('一路顺下来的 Bug：一次修好，轮数、经手次数、总时长和各阶段停留都按报告的时间算', () => {
  const m = bugMetrics(smooth())
  assert.equal(m.outcome, 'fixed')
  assert.equal(m.firstTry, true)
  assert.deepEqual([m.evidenceRounds, m.questioned, m.verifyFailed, m.reopened], [1, 0, 0, 0])
  // 论证那一版同意加日志、再贴日志算两次，其余四版各一次
  assert.equal(m.decisions, 6)
  assert.equal(m.totalMs, 100 * MIN)
  // 第一份报告之前的 10 分钟算论证；每一版到下一版交上来为止；最后一版到用户点结束
  assert.deepEqual(m.phaseMs, { evidence: 40 * MIN, cause: 10 * MIN, plan: 20 * MIN, fix: 10 * MIN, verify: 20 * MIN })
  assert.equal(m.tier, 'low')
})

test('根因被否决回到论证、验证没过重出方案：都记下来，最后修好了也不算一次修好', () => {
  const m = bugMetrics(
    bug('bumpy', [
      diag('evidence', 'approved', 10),
      // 被退回的那一版在新一版交上来后改成 superseded，但用户的决定时间还在
      diag('cause', 'superseded', 20, { decidedAt: at(25) }),
      diag('evidence', 'approved', 30),
      diag('cause', 'approved', 40),
      diag('plan', 'approved', 50),
      diag('fix', 'approved', 60),
      // 验证贴了结果，它分析后发现没修好，重新出方案
      diag('verify', 'answered', 70),
      diag('plan', 'approved', 80),
      diag('fix', 'approved', 90),
      diag('verify', 'approved', 100),
    ]),
  )
  assert.equal(m.outcome, 'fixed')
  assert.deepEqual([m.evidenceRounds, m.questioned, m.verifyFailed, m.reopened], [2, 1, 1, 1])
  assert.equal(m.firstTry, false)
})

test('退回只认用户做过决定的：没等到决定就被顶掉、同意加日志后等复现时被顶掉的都不算', () => {
  const m = bugMetrics(
    bug('superseded', [
      diag('evidence', 'superseded', 10),
      diag('evidence', 'superseded', 20, { decidedAt: at(22), awaiting: { at: at(24) } }),
      diag('verify', 'questioned', 30),
      diag('evidence', 'pending', 40),
    ]),
  )
  assert.equal(m.questioned, 0)
  // 验证那一版被退回只记在「验证没通过」里，不重复记成否决
  assert.equal(m.verifyFailed, 1)
  assert.equal(m.outcome, 'open')
  // 还没结束：没有总时长，最后一版也不算停留（还不知道停到什么时候）
  assert.equal(m.totalMs, undefined)
  assert.equal(m.phaseMs.verify, 10 * MIN)
  assert.equal(m.phaseMs.evidence, 10 * MIN + 10 * MIN + 10 * MIN)
})

test('结局：取消是不修了；标了已解决算修好，但没记结束时间就不算时长', () => {
  const cancelled = bugMetrics(bug('c', [diag('cause', 'cancelled', 10, { decidedAt: at(60) })]))
  assert.equal(cancelled.outcome, 'cancelled')
  assert.equal(cancelled.totalMs, 60 * MIN)
  // 取消不算一次经手的确认
  assert.equal(cancelled.decisions, 0)
  const resolved = bugMetrics(bug('r', [], { resolved: true }))
  assert.deepEqual([resolved.outcome, resolved.firstTry, resolved.totalMs], ['fixed', true, undefined])
  // 时间写坏了不抛错，那一段不算
  const broken = bugMetrics(bug('b', [diag('evidence', 'approved', 10, { at: 'x' }), diag('cause', 'pending', 20)]))
  assert.deepEqual(broken.phaseMs, {})
})

test('汇总：只统计标了 bug 的对话；一次修好按修好的算比例，平均值只算交过报告的，等级按最新评级分布', () => {
  const rejected = bug('rejected', [
    diag('cause', 'superseded', 10, { decidedAt: at(15), rating: { tier: 'high', percent: 40 } }),
    diag('cause', 'approved', 20, { rating: { tier: 'mid', percent: 80 } }),
    diag('verify', 'approved', 30),
  ])
  const { bugs, summary } = bugStats([
    smooth(),
    rejected,
    bug('new', []),
    { id: 'plain', createdAt: at(0), diagnoses: smooth().diagnoses },
  ])
  assert.deepEqual(
    bugs.map((x) => x.id),
    ['smooth', 'rejected', 'new'],
  )
  assert.deepEqual([summary.total, summary.open, summary.fixed, summary.cancelled], [3, 1, 2, 0])
  assert.deepEqual([summary.firstTry, summary.firstTryRate], [1, 0.5])
  // 刚立案的那个没交过报告，不拉低平均：(6 + 3) / 2、(1 + 0) / 2
  assert.equal(summary.avgDecisions, 4.5)
  assert.equal(summary.avgEvidenceRounds, 0.5)
  assert.deepEqual(summary.tiers, { low: 1, mid: 1, high: 0 })
  assert.equal(summary.avgTotalMs, (100 * MIN + 35 * MIN) / 2)
  assert.equal(summary.avgPhaseMs.fix, 10 * MIN)
})

test('一个 Bug 都没有：比例和平均值是 undefined（界面画成「—」），不是 0', () => {
  const { summary } = bugStats([])
  assert.equal(summary.total, 0)
  assert.deepEqual(
    [summary.firstTryRate, summary.avgDecisions, summary.avgEvidenceRounds, summary.avgTotalMs],
    [undefined, undefined, undefined, undefined],
  )
  assert.deepEqual(summary.avgPhaseMs, {})
})
