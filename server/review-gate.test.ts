import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlanStep, TaskStep } from '../shared/schema.ts'
import { applyPlan } from '../shared/plan.ts'
import { blockingIds, reviewGate, triageInput } from '../shared/review-gate.ts'

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

test('评审门禁：不通过时不要求复看到通过，要求逐条写处置（ADR 0009）', () => {
  const r = reviewGate([sub({ output: blocked })], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /还没写处置/)
  assert.match(r.ok === false ? r.info : '', /review_triage/)
  // 评审没编号：写一条处置（id 写意见原话摘要）就放行，采不采纳是执行角色的事
  const t = [
    { id: '少判空', decision: 'fix' as const, reason: '读了 server/tasks.ts:1120，确实会空指针，已补判空和用例' },
  ]
  assert.equal(reviewGate([sub({ output: blocked })], isReviewer, planDone, t).ok, true)
})

const numbered = [
  '验收结论：不通过',
  '必须改：R1、R2',
  '🛑 R1 server/a.ts:10 少判空',
  '🛑 R2 shared/b.ts:20 口径不一致',
  '💭 建议：命名可以短一点',
].join('\n')

test('评审门禁：每个 🛑 编号都要有处置，缺哪个说哪个', () => {
  const one = [{ id: 'R1', decision: 'fix' as const, reason: '核实是真问题，已补判空并加用例' }]
  const r = reviewGate([sub({ output: numbered })], isReviewer, planDone, one)
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
  assert.equal(reviewGate([sub({ output: numbered })], isReviewer, planDone, both).ok, true, '编号不分大小写')
})

test('评审门禁：处置的理由太短不算（说不清怎么核实的）', () => {
  const t = [
    { id: 'R1', decision: 'fix' as const, reason: '改了' },
    { id: 'R2', decision: 'defer' as const, reason: '范围外：重启落盘那段归另一个子对话，影响已停止任务的跨度' },
  ]
  const r = reviewGate([sub({ output: numbered })], isReviewer, planDone, t)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /R1 的理由太短/)
})

test('评审门禁：🛑 编号写在开头那行就认，正文被截断也不漏', () => {
  assert.deepEqual(blockingIds('验收结论：不通过\n必须改：R1、R2、R3\n🛑 R1 …'), ['R1', 'R2', 'R3'])
  assert.deepEqual(blockingIds('验收结论：通过\n必须改：无'), [])
})

test('评审门禁：写了通过却列了带编号的 🛑，按有 🛑 处理', () => {
  const output = '验收结论：通过\n🛑 R1 server/a.ts:10 少判空'
  assert.equal(reviewGate([sub({ output })], isReviewer, planDone).ok, false)
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

test('评审门禁：工具参数里的处置认不出的项丢掉', () => {
  assert.deepEqual(
    triageInput([{ id: 'R1', decision: 'fix', reason: '已改' }, { id: 'R2', decision: 'maybe' }, null, 'x']),
    [{ id: 'R1', decision: 'fix', reason: '已改' }],
  )
  assert.deepEqual(triageInput('R1'), [])
})

test('评审门禁：四级意见里高级、中级要处置，低级和建议不用', () => {
  const output = [
    '验收结论：通过',
    '必须处置：R1',
    '🟠 R1 server/a.ts:10 失败场景：传空数组时返回 undefined',
    '🟡 命名可以更短',
    '💡 以后可以换成 Map',
  ].join('\n')
  // 通过但列了中级：仍要处置
  const r = reviewGate([sub({ output })], isReviewer, planDone)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.info : '', /R1 还没有处置/)
  const t = [{ id: 'R1', decision: 'defer' as const, reason: '空数组只在旧导入数据里出现，这次范围外，记进遗留' }]
  assert.equal(reviewGate([sub({ output })], isReviewer, planDone, t).ok, true)
  // 复看正文里提到上一轮的编号不算新的意见
  const recheck = ['验收结论：通过', '必须处置：无', '上一轮的高级 R1、中级 R2 都已改好。'].join('\n')
  assert.equal(reviewGate([sub({ output: recheck })], isReviewer, planDone).ok, true)
  assert.deepEqual(blockingIds('验收结论：不通过\n必须处置：R1、R2\n🔴 R1 …\n🟠 R2 …'), ['R1', 'R2'])
})
