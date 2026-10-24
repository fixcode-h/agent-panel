import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlanStep, TaskStep } from '../shared/schema.ts'
import { applyPlan } from '../shared/plan.ts'
import { reviewGate } from '../shared/review-gate.ts'

const REVIEWER = 'a-reviewer'
const isReviewer = (id: string) => id === REVIEWER

function sub(over: Partial<Parameters<typeof TaskStep.parse>[0]> = {}) {
  return TaskStep.parse({
    id: `chat/sub/h${Math.random().toString(16).slice(2)}`,
    parentId: 'chat',
    slot: 'sub',
    title: '评审改动',
    agentId: REVIEWER,
    status: 'done',
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    ...over,
  })
}

/** 计划里那条评审步骤（执行角色收尾时要单独写进计划） */
function reviewStep(over: Partial<Parameters<typeof PlanStep.parse>[0]> = {}) {
  return PlanStep.parse({ id: '2', title: '评审本次改动', status: 'done', review: true, ...over })
}

const planDone = [PlanStep.parse({ id: '1', title: '改代码', status: 'done' }), reviewStep()]

/** 照着角色设定写的评审结果 */
const passed = '💭 建议：错误处理可以合并。\n验收结论：通过'
const blocked = '🛑 必须改：server/tasks.ts:1120 少判空。\n验收结论：不通过'

test('评审门禁：计划里没有评审步骤时拦下，并说清要单独写进计划', () => {
  const r = reviewGate([sub({ output: passed })], isReviewer, [
    PlanStep.parse({ id: '1', title: '改代码', status: 'done' }),
  ])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /计划里缺少评审步骤/)
  assert.match(r.ok === false ? r.info : '', /review: true/)
})

test('评审门禁：计划里的评审步骤还没完成时拦下（派评审时标等待中，拿回结论再标完成）', () => {
  const r = reviewGate([sub({ output: passed })], isReviewer, [
    PlanStep.parse({ id: '1', title: '改代码', status: 'done' }),
    reviewStep({ status: 'waiting' }),
  ])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /还没完成/)
})

test('评审门禁：计划里有两个评审步骤时，后一步没做完也拦下', () => {
  const r = reviewGate([sub({ output: passed })], isReviewer, [
    PlanStep.parse({ id: '1', title: '改代码', status: 'done' }),
    reviewStep({ id: '2', title: '评审本次改动', status: 'done' }),
    reviewStep({ id: '3', title: '复看评审', status: 'waiting' }),
  ])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /复看评审/)
  assert.match(r.ok === false ? r.info : '', /还没完成/)
})

test('评审门禁：没派过评审时拦下，并给出派评审的写法', () => {
  const r = reviewGate([sub({ agentId: 'a-helper', title: '查代码' })], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /还没有真的派过「评审」/)
  assert.match(r.ok === false ? r.info : '', /spawn_agents 的 agent 写「评审」/)
})

test('评审门禁：结论写在第一行时以首行为准，正文提到上一轮「不通过」不影响', () => {
  const output = ['验收结论：通过', '🛑 上一轮的「验收结论：不通过」都已改掉，复看没有新问题。'].join('\n')
  assert.equal(reviewGate([sub({ output })], isReviewer, planDone).ok, true)
  // 首行没有结论时才退回全文最后一条（兼容不按约定写的老报告）
  const legacy = ['💭 建议：可以再简化一点。', '验收结论：通过'].join('\n')
  assert.equal(reviewGate([sub({ output: legacy })], isReviewer, planDone).ok, true)
})

test('评审门禁：首行的验收结论带前缀或加粗也认（评审的常见写法）', () => {
  const cases: [string, boolean][] = [
    ['评审结论：不通过\n🛑 必须改：xxx', false],
    ['**验收结论：不通过**\n🛑 必须改：xxx', false],
    ['验收结论：**不通过**\n🛑 必须改：xxx', false],
    ['验收结论：通过\n💭 建议：可以再简化一点', true],
  ]
  for (const [output, pass] of cases) assert.equal(reviewGate([sub({ output })], isReviewer, planDone).ok, pass, output)
})

test('评审门禁：最近一次评审通过才放行', () => {
  assert.equal(reviewGate([sub({ output: passed })], isReviewer, planDone).ok, true)
})

test('评审门禁：英文的 Verdict: pass 也认（回复语言不定时）', () => {
  assert.equal(reviewGate([sub({ output: 'No blockers.\nVerdict: pass' })], isReviewer, planDone).ok, true)
})

test('评审门禁：结论是不通过时拦下，要求改完再复看', () => {
  const r = reviewGate([sub({ output: blocked })], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /「不通过」/)
  assert.match(r.ok === false ? r.info : '', /再派一次「评审」复看/)
})

test('评审门禁：改完复看通过后放行，只看最后一次', () => {
  assert.equal(reviewGate([sub({ output: blocked }), sub({ output: passed })], isReviewer, planDone).ok, true)
})

test('评审门禁：评审没写结论时拦下，要求补一行验收结论', () => {
  const r = reviewGate([sub({ output: '💅 细节：命名可以更短。' })], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /没有写验收结论/)
})

test('评审门禁：评审还在跑、或者没正常结束时拦下', () => {
  const running = reviewGate([sub({ status: 'running', endedAt: '', output: '' })], isReviewer, planDone)
  assert.equal(running.ok, false)
  assert.match(running.ok === false ? running.info : '', /还没跑完/)
  const failed = reviewGate([sub({ status: 'failed', output: '' })], isReviewer, planDone)
  assert.equal(failed.ok, false)
  assert.match(failed.ok === false ? failed.info : '', /重新派一次/)
})

test('评审门禁：别的角色的子任务不算评审', () => {
  const r = reviewGate(
    [sub({ agentId: 'a-doc', title: '写文档', output: '验收结论：通过' }), sub({ output: blocked })],
    isReviewer,
    planDone,
  )
  assert.equal(r.ok, false, '最后一票在评审角色上：写文档那步的结论不算数')
})

test('计划：评审步骤的 review 标记会存下来，完成之后也能补', () => {
  const task = { plans: [] as never[], steps: [] as never[] } as never as { plans: never[]; steps: never[] }
  const at = new Date(0).toISOString()
  // 一直留一步没做完的，保证后面几次都在同一份计划里：全部完成时计划会结束，再改会新开一份
  const rest = { title: '跑完整测试' }
  const first = applyPlan(
    task as never,
    { steps: [rest, { title: '改代码', status: 'done' }, { title: '评审本次改动', status: 'waiting', review: true }] },
    at,
  )
  assert.ok(first.ok)
  const stepsOf = () => (task as unknown as { plans: { steps: PlanStep[] }[] }).plans[0].steps
  assert.equal(stepsOf().find((s) => s.title === '评审本次改动')?.review, true)
  assert.equal(stepsOf().find((s) => s.title === '改代码')?.review, false)
  applyPlan(task as never, { steps: [rest, { title: '评审本次改动', status: 'waiting', review: false }] }, at)
  assert.equal(stepsOf().find((s) => s.title === '评审本次改动')?.review, false)
  // 已完成的步骤也能补上 review 标记：模型先标了完成、才发现漏标时改得动（内容仍不能改）
  applyPlan(task as never, { steps: [rest, { title: '评审本次改动', status: 'done' }] }, at)
  applyPlan(task as never, { steps: [rest, { title: '评审本次改动', status: 'done', review: true }] }, at)
  const after = stepsOf().find((s) => s.title === '评审本次改动')!
  assert.equal(after.review, true, 'done 之后仍能补上 review 标记')
  assert.equal(after.status, 'done')
})
