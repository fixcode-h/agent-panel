/**
 * 总览页 Bug 视图的行：裁成精简字段、现在等谁、五步走到哪、分组和排序。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bugBriefs, bugRows, bugStep } from './bug-overview.ts'
import { Task } from './schema.ts'

const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 8, 0) + min * 60_000).toISOString()
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({
    id,
    projectId: 'p',
    title: id,
    mode: 'chat',
    status: 'done',
    createdAt: at(0),
    updatedAt: at(0),
    ...extra,
  })
const diag = (version: number, phase: string, status: string, min: number, extra: Record<string, unknown> = {}) => ({
  version,
  phase,
  confirmed: phase !== 'evidence',
  at: at(min),
  status,
  ...extra,
})
const kid = (id: string, diagnoses: unknown[], extra: Record<string, unknown> = {}) =>
  task(id, { bug: { kind: 'report', diagnoses: diagnoses }, parentTaskId: 'top', ...extra })

test('裁剪：只列标了 bug 的对话，带父对话标题和要打开的顶层对话；多层子对话在顶层对话名下的那一层打开；回收站里的不列', () => {
  const briefs = bugBriefs([
    task('top', { title: '购物车改版' }),
    task('mid', { parentTaskId: 'top' }),
    kid('direct', [
      diag(1, 'cause', 'pending', 10, {
        level: 'deep',
        rating: { tier: 'mid', percent: 70, why: '很长的理由' },
        symptom: '现象',
      }),
    ]),
    task('deep', { bug: { kind: 'report' }, parentTaskId: 'mid' }),
    kid('trashed', [], { deletedAt: at(5) }),
    task('gone', { deletedAt: at(5) }),
    task('orphan', { bug: { kind: 'report' }, parentTaskId: 'gone' }),
    task('plain', { parentTaskId: 'top' }),
  ])
  assert.deepEqual(
    briefs.map((b) => [b.id, b.parentTitle, b.rootId, b.paneId]),
    [
      ['direct', '购物车改版', 'top', 'direct'],
      ['deep', 'mid', 'top', 'mid'],
    ],
  )
  const [direct, deep] = briefs
  assert.equal(direct.level, 'deep')
  // 报告只留视图和统计要的几项：正文、评级的理由都不带
  assert.deepEqual(direct.diagnoses, [
    {
      version: 1,
      rev: undefined,
      phase: 'cause',
      confirmed: true,
      at: at(10),
      status: 'pending',
      level: 'deep',
      decidedAt: undefined,
      awaiting: undefined,
      rating: { tier: 'mid', percent: 70 },
      cleanup: undefined,
    },
  ])
  // 还没交过报告、也没有档案：级别按标准
  assert.deepEqual([deep.level, deep.diagnoses], ['standard', []])
})

test('现在等谁：只看报告的状态和对话状态；等你的排最上面，然后进行中，然后已结束', () => {
  const rows = bugRows(
    bugBriefs([
      task('top'),
      kid('confirm', [diag(1, 'plan', 'pending', 30)]),
      kid('repro', [diag(1, 'evidence', 'pending', 10, { decidedAt: at(12), awaiting: { at: at(20) } })]),
      kid('verify', [diag(1, 'verify', 'pending', 40)]),
      kid('analyzing', [diag(1, 'evidence', 'answered', 10, { decidedAt: at(50) })], {
        status: 'running',
        working: true,
      }),
      kid('new', [], { status: 'running', working: true }),
      kid('idle', [diag(1, 'cause', 'approved', 10, { decidedAt: at(15) })]),
      kid('failed', [diag(1, 'cause', 'approved', 10, { decidedAt: at(15) })], { status: 'failed' }),
      kid('cancelled', [diag(1, 'cause', 'cancelled', 10, { decidedAt: at(60) })]),
      kid('cleaning', [
        diag(1, 'cause', 'cancelled', 10, { decidedAt: at(60), cleanup: { state: 'running', at: at(60) } }),
      ]),
      kid('unclean', [
        diag(1, 'cause', 'cancelled', 10, { decidedAt: at(60), cleanup: { state: 'failed', at: at(60) } }),
      ]),
      kid('ended', [diag(1, 'verify', 'approved', 10, { decidedAt: at(90) })]),
      kid('resolved', [diag(1, 'fix', 'approved', 10, { decidedAt: at(70) })], { resolved: true }),
      kid('archived', [diag(1, 'plan', 'pending', 30)], { archived: true }),
    ]),
  )
  const by = Object.fromEntries(rows.map((r) => [r.bug.id, r.who]))
  assert.deepEqual(by, {
    confirm: 'confirm',
    repro: 'repro',
    verify: 'verify',
    analyzing: 'analyzing',
    new: 'analyzing',
    idle: 'idle',
    failed: 'failed',
    cancelled: 'cancelled',
    cleaning: 'cleaning',
    // 临时日志核对没过：等你决定再删一次还是自己处理
    unclean: 'confirm',
    ended: 'fixed',
    resolved: 'fixed',
  })
  assert.deepEqual(
    rows.map((r) => r.group),
    [...Array(5).fill('you'), ...Array(4).fill('active'), ...Array(3).fill('ended')],
  )
  // 等你的按等得最久的在前（起点是最后一份报告上最晚的时间：请你复现的 20 分 < 方案 30 分 < 验证 40 分）；已结束的最近结束的在前
  assert.deepEqual(
    rows.filter((r) => r.group === 'you').map((r) => r.bug.id),
    ['failed', 'repro', 'confirm', 'verify', 'unclean'],
  )
  assert.deepEqual(
    rows.filter((r) => r.group === 'ended').map((r) => r.bug.id),
    ['ended', 'resolved', 'cancelled'],
  )
  assert.equal(rows.find((r) => r.bug.id === 'repro')?.since, at(20))
  assert.equal(rows.find((r) => r.bug.id === 'new')?.since, at(0))
})

test('五步走到哪：和诊断报告弹窗的阶段条一样，同意了才进下一步，验证点了结束才算走完', () => {
  const step = (phase: string, status: string) =>
    bugStep(bugBriefs([task('top'), kid('k', [diag(1, phase, status, 1)])])[0].diagnoses)
  assert.equal(bugStep([]), 0)
  // 同意加日志还在论证；旧数据没有 phase 的按 confirmed 推（phaseOf）
  assert.deepEqual([step('evidence', 'approved'), step('evidence', 'answered')], [0, 0])
  assert.deepEqual([step('cause', 'pending'), step('cause', 'approved')], [1, 2])
  assert.deepEqual([step('plan', 'questioned'), step('plan', 'approved')], [2, 3])
  assert.deepEqual([step('fix', 'pending'), step('fix', 'approved')], [3, 4])
  assert.deepEqual([step('verify', 'answered'), step('verify', 'approved')], [4, 5])
  assert.equal(bugStep([{ version: 1, confirmed: true, at: at(1), status: 'pending' }]), 2)
})
