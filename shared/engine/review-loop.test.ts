import assert from 'node:assert/strict'
import test from 'node:test'
import { carriedFeedback, reviewFeedback, runReviewLoop, type ReviewLoop } from './review-loop.ts'
import type { EngineHost } from './host.ts'
import { Task, TaskStep } from '../schema.ts'
import type { Blocker } from '../submitted.ts'

type Round = { verdict: 'pass' | 'fail'; blockers?: Partial<Blocker>[]; output?: string }

/** 按剧本跑验收：第 n 轮交 rounds[n-1] 的结论，记下每次返工收到的提示 */
function setup(rounds: Round[], extra: Partial<EngineHost> = {}, maxRounds = 2) {
  const task = Task.parse({
    id: 't',
    projectId: 'p',
    title: 'x',
    mode: 'workflow',
    status: 'running',
    createdAt: '',
    updatedAt: '',
  })
  const target = TaskStep.parse({ id: 'n', title: '写规范', agentId: 'a', verdict: '' })
  task.steps.push(target)
  const host = { task, changed: () => {}, ...extra } as unknown as EngineHost
  const reworks: string[] = []
  const notes: string[] = []
  let counter = 0
  const loop: ReviewLoop = {
    host,
    target,
    handoff: target,
    maxRounds,
    nextRound: () => ++counter,
    run: async (round) => {
      const r = rounds[round - 1] ?? { verdict: 'pass' }
      const blockers = (r.blockers ?? []).map((b) => ({ id: '', text: '', must: false, ...b }))
      task.steps.push(
        TaskStep.parse({
          id: `n/review.${round}/gate`,
          title: '规范门禁',
          parentId: 'n',
          slot: 'review',
          round,
          output: r.output ?? '',
          submitted: { verdict: r.verdict, blockers, at: `2026-11-25T00:00:0${round}Z` },
        }),
      )
      return { ok: true, output: r.output ?? '' }
    },
    rework: async (agentText) => {
      reworks.push(agentText)
      return { ok: true, text: `第 ${reworks.length} 版` }
    },
    done: () => {},
    note: (text) => notes.push(text),
  }
  return { loop, target, task, reworks, notes }
}

const must = (id: string) => ({ id, text: `${id} 要改`, must: true })

test('返工提示带上 submit_verdict 的意见原文，必须改和建议分开列', async () => {
  const { loop, reworks } = setup([
    { verdict: 'fail', blockers: [must('F1'), { id: 'F7', text: '建议换个写法' }], output: '跑了校验。' },
    { verdict: 'pass' },
  ])
  assert.equal(await runReviewLoop(loop), null)
  assert.match(reworks[0], /必须改（1 条[\s\S]*F1：F1 要改/)
  assert.match(reworks[0], /建议（1 条[\s\S]*F7：建议换个写法/)
  assert.match(reworks[0], /验收过程的说明\n跑了校验。/)
})

test('问题一轮比一轮少不算原地打转：超过 maxRounds 轮也接着改，直到通过', async () => {
  const { loop, target, reworks } = setup([
    { verdict: 'fail', blockers: [must('F1'), must('F2'), must('F3')] },
    { verdict: 'fail', blockers: [must('F4'), must('F5')] },
    { verdict: 'fail', blockers: [must('F6')] },
    { verdict: 'pass' },
  ])
  assert.equal(await runReviewLoop(loop), null)
  assert.equal(reworks.length, 3)
  assert.equal(target.verdict, 'pass')
  assert.equal(target.reviews, 3)
})

test('问题没变少到上限：没有弹卡的宿主按「验收没有通过」停下，意见带清单', async () => {
  const { loop } = setup([
    { verdict: 'fail', blockers: [must('F1')] },
    { verdict: 'fail', blockers: [must('F2')] },
  ])
  const r = await runReviewLoop(loop)
  assert.ok(r && !r.ok)
  assert.equal(r.kind, 'review')
  assert.match(r.error, /验收 2 轮仍未通过[\s\S]*F2：F2 要改/)
})

test('一直在变少也有总轮数兜底：maxRounds 的两倍', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    verdict: 'fail' as const,
    blockers: Array.from({ length: 8 - i }, (_, k) => must(`F${i}-${k}`)),
  }))
  const { loop, reworks } = setup(many)
  const r = await runReviewLoop(loop)
  assert.ok(r && !r.ok)
  assert.equal(reworks.length, 3, '第 4 轮到了兜底，不再返工')
})

test('到上限问用户：选按现状通过就记成通过往下走', async () => {
  const asked: string[] = []
  const { loop, target, notes } = setup(
    [
      { verdict: 'fail', blockers: [must('F1')] },
      { verdict: 'fail', blockers: [must('F1')] },
    ],
    {
      reviewLimit: async (_s, info) => {
        asked.push(info.feedback)
        return 'pass'
      },
    },
  )
  assert.equal(await runReviewLoop(loop), null)
  assert.equal(asked.length, 1)
  assert.match(asked[0], /F1：F1 要改/)
  assert.equal(target.verdict, 'pass')
  assert.ok(notes.some((n) => n.includes('按现状通过')))
})

test('到上限选再改一轮：改一次再验收，还不过再问；停止就按停止返回', async () => {
  const picks: ('again' | null)[] = ['again', null]
  const { loop, reworks } = setup(
    [
      { verdict: 'fail', blockers: [must('F1')] },
      { verdict: 'fail', blockers: [must('F1')] },
      { verdict: 'fail', blockers: [must('F1')] },
    ],
    { reviewLimit: async () => picks.shift() ?? null },
  )
  const r = await runReviewLoop(loop)
  assert.ok(r && !r.ok && r.stopped)
  assert.equal(reworks.length, 2, '第 1 轮正常返工，第 2 轮选了再改一轮，第 3 轮再问时停下')
  assert.equal(picks.length, 0)
})

test('重新执行没通过的节点：带上最后一轮的意见，通过过的不带', async () => {
  const { loop, task, target } = setup([
    { verdict: 'fail', blockers: [must('F1')] },
    { verdict: 'fail', blockers: [must('F17')], output: '1.1 依赖后面的组' },
  ])
  await runReviewLoop(loop)
  const text = carriedFeedback(task.steps, target)
  assert.match(text, /第 2 轮[\s\S]*F17：F17 要改[\s\S]*1\.1 依赖后面的组/)
  assert.doesNotMatch(text, /F1：/)
  target.verdict = 'pass'
  assert.equal(carriedFeedback(task.steps, target), '')
})

test('没交清单的旧验收：只交说明，和以前一样', () => {
  assert.equal(reviewFeedback([], '有一处要改'), '### 验收过程的说明\n有一处要改')
  assert.equal(reviewFeedback([], ''), '（验收没有写意见）')
})
