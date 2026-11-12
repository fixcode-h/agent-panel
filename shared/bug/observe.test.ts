/**
 * 偶发 Bug 的观察期（分析稿 B13）和普通对话就地查 Bug（B10）的判定。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bugBriefs, bugRows } from './overview.ts'
import { bugInPlace, inPlaceBugClosed } from './in-place.ts'
import {
  bugTerms,
  findRelapse,
  intermittent,
  markRelapse,
  observation,
  observingUntil,
  relapseNote,
  termsMatch,
} from './observe.ts'
import { BugCase } from './diagnosis-schema.ts'
import { defaultAgent, Task } from '../schema.ts'

const day = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 86400000).toISOString()
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({
    id,
    projectId: 'p',
    title: id,
    mode: 'chat',
    status: 'done',
    createdAt: day(0),
    updatedAt: day(0),
    ...extra,
  })
const verified = (n: number, symptom = '') => ({
  version: 1,
  phase: 'verify',
  confirmed: true,
  at: day(n),
  decidedAt: day(n),
  status: 'approved',
  symptom,
})
/** extra 里的 bug 只覆盖给出的那几项（档案、报告），其余照默认 */
const fixedBug = (
  id: string,
  title: string,
  symptom: string,
  n = 1,
  { bug, ...extra }: { bug?: Record<string, unknown> } & Record<string, unknown> = {},
) =>
  task(id, {
    bug: {
      kind: 'report',
      case: BugCase.parse({ symptom, rootCause: '订阅在数据到达之后才建', files: ['web/src/avatar.ts'] }),
      diagnoses: [verified(n, symptom)],
      ...bug,
    },
    title,
    parentTaskId: 'top',
    ...extra,
  })

test('偶发：看现象卡里的频率，明说必现的不算；验证记了运行次数的也算', () => {
  assert.equal(
    intermittent({ bug: { kind: 'report', case: BugCase.parse({ symptom: '登录后头像偶尔不刷新，十次两三次' }) } }),
    true,
  )
  assert.equal(intermittent({ bug: { kind: 'report', case: BugCase.parse({ symptom: '必现，不是偶发' }) } }), false)
  assert.equal(intermittent({ bug: { kind: 'report', case: BugCase.parse({ symptom: '保存按钮点了没反应' }) } }), false)
  assert.equal(
    intermittent({
      bug: { kind: 'report', case: BugCase.parse({ symptom: '保存失败', result: { runs: '跑 30 次坏 0 次' } }) },
    }),
    true,
  )
})

test('观察期：偶发的修好后观察 7 天，按验证点结束的时间算；没修好、不是偶发的没有', () => {
  const a = fixedBug('a', '头像不刷新', '偶发：头像不刷新', 1)
  assert.deepEqual(observation(a), { since: day(1), until: day(8) })
  assert.equal(observingUntil(a, day(3)), day(8))
  assert.equal(observingUntil(a, day(9)), undefined, '过了 7 天就不观察了')
  assert.equal(observation(fixedBug('b', '头像不刷新', '必现：头像不刷新')), undefined)
  const open = fixedBug('c', '头像不刷新', '偶发', 1, {
    bug: { diagnoses: [{ ...verified(1, '偶发'), status: 'pending' }] },
  })
  assert.equal(observation(open), undefined)
})

test('关键词：标识符和中文两字组对上足够多才算同一类，只对上一两个常见词的不算', () => {
  const orig = bugTerms('登录后头像偶尔不刷新 AvatarStore')
  assert.ok(termsMatch(bugTerms('头像又不刷新了，登录后看到旧头像'), orig) > 0)
  assert.ok(termsMatch(bugTerms('AvatarStore 里的头像没更新'), orig) > 0)
  assert.equal(termsMatch(bugTerms('导出订单 CSV 中文乱码'), orig), 0)
  assert.equal(termsMatch(bugTerms('登录后报错'), orig), 0)
})

test('再报关联：同项目、观察期里、最像的一个；关联后原来的记一笔，派单附上原来的根因和修法', () => {
  const a = fixedBug('a', '登录后头像偶尔不刷新', '偶发：登录后头像不刷新', 1)
  const other = fixedBug('o', '导出订单偶尔中文乱码', '偶发：导出订单中文乱码', 1)
  const elsewhere = fixedBug('x', '登录后头像偶尔不刷新', '偶发', 1, { projectId: 'q' })
  const fresh = { id: 'n', projectId: 'p', text: '头像又不刷新\n用户说登录后头像还是旧的，偶尔出现' }
  assert.equal(findRelapse([a, other, elsewhere], fresh, day(3))?.id, 'a')
  assert.equal(findRelapse([a], fresh, day(9)), undefined, '观察期过了不关联')
  assert.equal(findRelapse([a], { ...fresh, projectId: 'q' }, day(3)), undefined)
  markRelapse(a, { id: 'n', title: '头像又不刷新' }, 'm1', day(3))
  markRelapse(a, { id: 'n', title: '头像又不刷新' }, 'm2', day(3))
  assert.deepEqual(a.bug?.case?.relapses, [{ id: 'n', title: '头像又不刷新', at: day(3) }], '同一个只记一次')
  assert.match(a.messages.at(-1)!.text, /观察期里又报了同类问题「头像又不刷新」/)
  const note = relapseNote(a, day(8))
  assert.match(note, /订阅在数据到达之后才建/)
  assert.match(note, /`web\/src\/avatar\.ts`/)
  assert.match(note, /对话 id a/)
})

test('总览：观察中列进「进行中」，观察期里又报了的提到「等你处理」，过了观察期是已修好', () => {
  const tasks = [
    task('top'),
    fixedBug('watch', '头像偶尔不刷新', '偶发', 1),
    fixedBug('back', '列表偶尔重复', '偶发', 1, {
      bug: {
        case: BugCase.parse({ symptom: '偶发', relapses: [{ id: 'n', title: '列表又重复', at: day(2) }] }),
      },
    }),
    fixedBug('steady', '保存按钮', '必现', 1),
  ]
  const who = (now: string) => Object.fromEntries(bugRows(bugBriefs(tasks), now).map((r) => [r.bug.id, r.who]))
  assert.deepEqual(who(day(3)), { watch: 'observing', back: 'relapsed', steady: 'fixed' })
  assert.deepEqual(who(day(10)), { watch: 'fixed', back: 'fixed', steady: 'fixed' })
  const groups = Object.fromEntries(bugRows(bugBriefs(tasks), day(3)).map((r) => [r.bug.id, r.group]))
  assert.deepEqual(groups, { watch: 'active', back: 'you', steady: 'ended' })
})

test('普通对话就地查 Bug：子对话、有项目且角色不能派子对话的顶层对话才标；父对话、Chat 页、工作流不标', () => {
  const lead = { ...defaultAgent(), id: 'lead', canDelegate: true }
  const worker = { ...defaultAgent(), id: 'worker', canDelegate: false }
  const agents = [lead, worker]
  assert.equal(bugInPlace({ parentTaskId: 'top', projectId: 'p', mode: 'chat', agentId: 'lead' }, agents), true)
  assert.equal(bugInPlace({ projectId: 'p', mode: 'chat', agentId: 'worker' }, agents), true)
  assert.equal(bugInPlace({ projectId: 'p', mode: 'chat', agentId: '' }, agents), true, '无角色的普通对话')
  assert.equal(bugInPlace({ projectId: 'p', mode: 'chat', agentId: 'lead' }, agents), false, '父对话派子对话')
  assert.equal(bugInPlace({ projectId: '', mode: 'chat', agentId: '' }, agents), false, 'Chat 页没有项目')
  assert.equal(bugInPlace({ projectId: 'p', mode: 'workflow', agentId: '' }, agents), false)
})

test('普通对话里的 Bug 结束后不再拦改文件：修好了、不修了且临时日志删完；子对话不算', () => {
  const solo = (diagnoses: unknown[]) => task('s', { bug: { kind: 'report', diagnoses: diagnoses } })
  assert.equal(inPlaceBugClosed(solo([verified(1)])), true)
  assert.equal(inPlaceBugClosed(solo([{ ...verified(1), phase: 'cause', status: 'cancelled' }])), true)
  assert.equal(
    inPlaceBugClosed(
      solo([{ ...verified(1), phase: 'cause', status: 'cancelled', cleanup: { state: 'running', at: day(1) } }]),
    ),
    false,
    '还在删临时日志',
  )
  assert.equal(inPlaceBugClosed(solo([{ ...verified(1), status: 'pending' }])), false)
  assert.equal(
    inPlaceBugClosed(task('c', { bug: { kind: 'report', diagnoses: [verified(1)] }, parentTaskId: 'top' })),
    false,
  )
})
