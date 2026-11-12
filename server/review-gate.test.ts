import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlanStep, TaskStep } from '../shared/schema.ts'
import { applyPlan } from '../shared/plan.ts'
import { overrideInput, reviewGate, triageInput } from '../shared/review/gate.ts'

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

/** 评审用 submit_verdict 交的结论（门禁只认它，不看回复文字）；ids 是必须处置的意见编号 */
const sv = (verdict: 'pass' | 'fail', ids: string[] = []) => ({
  submitted: {
    verdict,
    blockers: ids.map((id) => ({ id, text: `${id} 的问题`, must: true })),
    summary: '',
    left: '',
    at: new Date(1).toISOString(),
  },
})
const passed = sv('pass')
/** 不通过、意见没编号 */
const blocked = {
  submitted: { ...sv('fail').submitted, blockers: [{ id: '', text: 'server/tasks.ts:1120 少判空', must: true }] },
}

test('评审门禁：计划里没有评审步骤时拦下，并说清要单独写进计划', () => {
  const r = reviewGate([sub(passed)], isReviewer, [PlanStep.parse({ id: '1', title: '改代码', status: 'done' })])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /计划里缺少评审步骤/)
  assert.match(r.ok === false ? r.info : '', /review: true/)
})

test('评审门禁：计划里的评审步骤还没完成时拦下（派评审时标等待中，拿回结论再标完成）', () => {
  const r = reviewGate([sub(passed)], isReviewer, [
    PlanStep.parse({ id: '1', title: '改代码', status: 'done' }),
    reviewStep({ status: 'waiting' }),
  ])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /还没完成/)
})

test('评审门禁：计划里有两个评审步骤时，后一步没做完也拦下', () => {
  const r = reviewGate([sub(passed)], isReviewer, [
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

test('评审门禁：最近一次评审通过才放行', () => {
  assert.equal(reviewGate([sub(passed)], isReviewer, planDone).ok, true)
})

test('评审门禁：不通过时不要求复看到通过，要求逐条写处置（ADR 0009）', () => {
  const r = reviewGate([sub(blocked)], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /还没写处置/)
  assert.match(r.ok === false ? r.info : '', /review_triage/)
  // 评审没编号：写一条处置（id 写意见原话摘要）就放行，采不采纳是执行角色的事
  const t = [
    { id: '少判空', decision: 'fix' as const, reason: '读了 server/tasks.ts:1120，确实会空指针，已补判空和用例' },
  ]
  assert.equal(reviewGate([sub(blocked)], isReviewer, planDone, t).ok, true)
})

const numbered = sv('fail', ['R1', 'R2'])

test('评审门禁：每个 🛑 编号都要有处置，缺哪个说哪个', () => {
  const one = [{ id: 'R1', decision: 'fix' as const, reason: '核实是真问题，已补判空并加用例' }]
  const r = reviewGate([sub(numbered)], isReviewer, planDone, one)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /R2 还没有处置/)
  const both = [
    ...one,
    {
      id: 'r2',
      decision: 'reject' as const,
      reason: '两处都按 runMs 算，评审把 waitMs 看成了 runMs（shared/b.ts:20）',
    },
  ]
  assert.equal(reviewGate([sub(numbered)], isReviewer, planDone, both).ok, true, '编号不分大小写')
})

test('评审门禁：处置的理由太短不算（说不清怎么核实的）', () => {
  const t = [
    { id: 'R1', decision: 'fix' as const, reason: '改了' },
    { id: 'R2', decision: 'defer' as const, reason: '范围外：重启落盘那段归另一个子对话，影响已停止任务的跨度' },
  ]
  const r = reviewGate([sub(numbered)], isReviewer, planDone, t)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /R1 的理由太短/)
})

test('评审门禁：交了通过却列了必须处置的意见，按要处置处理', () => {
  assert.equal(reviewGate([sub(sv('pass', ['R1']))], isReviewer, planDone).ok, false)
})

test('评审门禁：只认 submit_verdict，不看回复文字（ADR 0041 第 16 节）', () => {
  // 回复里写了「验收结论：通过」但没调工具：不算交了结论
  const r = reviewGate([sub({ output: '验收结论：通过' })], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /没有用 submit_verdict 交结论/)
  // 工具交了通过，回复里写的「不通过」不影响
  assert.equal(reviewGate([sub({ output: '验收结论：不通过', ...passed })], isReviewer, planDone).ok, true)
})

test('评审门禁：改完复看通过后放行，只看最后一次', () => {
  assert.equal(reviewGate([sub(blocked), sub(passed)], isReviewer, planDone).ok, true)
})

test('评审门禁：评审没交结论时拦下，要求重新派一次让它交', () => {
  const r = reviewGate([sub({ output: '💅 细节：命名可以更短。' })], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /没有用 submit_verdict 交结论/)
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
  const r = reviewGate([sub({ agentId: 'a-doc', title: '写文档', ...passed }), sub(blocked)], isReviewer, planDone)
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

test('评审门禁：工具参数里的处置认不出的项丢掉', () => {
  assert.deepEqual(
    triageInput([{ id: 'R1', decision: 'fix', reason: '已改' }, { id: 'R2', decision: 'maybe' }, null, 'x']),
    [{ id: 'R1', decision: 'fix', reason: '已改' }],
  )
  assert.deepEqual(triageInput('R1'), [])
})

test('评审门禁：只有标 must 的意见要处置，建议性的不用', () => {
  const withMust = {
    submitted: {
      ...sv('pass').submitted,
      blockers: [
        { id: 'R1', text: '传空数组时返回 undefined', must: true },
        { id: 'R2', text: '命名可以更短', must: false },
      ],
    },
  }
  // 通过但列了要处置的：仍要处置
  const r = reviewGate([sub(withMust)], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /R1 还没有处置/)
  assert.doesNotMatch(r.ok === false ? r.info : '', /R2/)
  const t = [{ id: 'R1', decision: 'defer' as const, reason: '空数组只在旧导入数据里出现，这次范围外，记进遗留' }]
  assert.equal(reviewGate([sub(withMust)], isReviewer, planDone, t).ok, true)
})

test('评审门禁：拦下时一并给出显式放行通道，但不能自己判「问题不大」', () => {
  const r = reviewGate([sub(blocked)], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /review_override/)
  assert.match(r.ok === false ? r.info : '', /已知问题也合并/)
})

test('评审门禁：用户明确放行时通过，并带回「原本拦住什么」留给任务记录', () => {
  const r = reviewGate([sub(blocked)], isReviewer, planDone, [], {
    by: 'user',
    reason: '用户要求先合并这一版，少判空的空数组问题下一版补',
  })
  assert.equal(r.ok, true)
  assert.equal(r.ok === true ? r.bypass?.by : '', 'user')
  assert.match(r.ok === true ? (r.bypass?.blocked ?? '') : '', /R1|处置|不通过/)
})

test('评审门禁：放行理由太短不算说明，照旧拦下并说清差多少字', () => {
  const r = reviewGate([sub(blocked)], isReviewer, planDone, [], { by: 'user', reason: '先合' })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /理由太短/)
})

test('评审门禁：本来就能过时不记放行（记录只对应真绕过门禁的那次）', () => {
  const r = reviewGate([sub(passed)], isReviewer, planDone, [], {
    by: 'user',
    reason: '用户要求先合并这一版，少判空的空数组问题下一版补',
  })
  assert.equal(r.ok, true)
  assert.equal(r.ok === true ? r.bypass : undefined, undefined)
})

test('评审门禁：放行来源认不出、没写理由时当没传，仍按门禁拦下', () => {
  assert.equal(overrideInput({ by: '自己', reason: '这条理由够长但其实来源不合法' }), undefined)
  assert.equal(overrideInput({ by: 'user', reason: '' }), undefined)
  assert.deepEqual(overrideInput({ by: 'parent', reason: '父对话决定带着这个问题先合并' }), {
    by: 'parent',
    reason: '父对话决定带着这个问题先合并',
  })
})

test('评审门禁：放行来源走原型链的名字不算（hasOwn，不认 toString）', () => {
  assert.equal(overrideInput({ by: 'toString', reason: '这条理由长度够了但不是合法来源' }), undefined)
  assert.equal(overrideInput({ by: 'constructor', reason: '这条理由长度够了但不是合法来源' }), undefined)
})
