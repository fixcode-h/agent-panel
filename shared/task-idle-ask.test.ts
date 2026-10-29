import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childAutoAskWaiting, childIdleAsk, CHILD_IDLE_ASK_MAX, planStalled } from './task.ts'

/** 一分钟按 1 秒算：阈值、上限这些判定不用真的等几分钟 */
const unitMs = 1000
const at = (ms: number) => new Date(ms).toISOString()
const now = Date.parse(at(100_000))
const ask = (x: Parameters<typeof childIdleAsk>[0]) => childIdleAsk({ unitMs, ...x }, now)

test('没到阈值不问，到了才问', () => {
  const lastActivityAt = at(now - 2900)
  assert.deepEqual(ask({ minutes: 3, working: true, lastActivityAt }), {
    ask: false,
    reason: 'too-soon',
    idleMs: 2900,
    count: 0,
  })
  assert.deepEqual(ask({ minutes: 3, working: true, lastActivityAt: at(now - 3000) }), {
    ask: true,
    idleMs: 3000,
    count: 1,
  })
})

test('0 关闭自动询问', () => {
  const r = ask({ minutes: 0, working: true, lastActivityAt: at(now - 3600_000) })
  assert.equal(r.ask, false)
  assert.equal(r.reason, 'off')
})

test('没在执行（等下一句、已经停下）不问', () => {
  const r = ask({ minutes: 3, working: false, lastActivityAt: at(now - 3600_000) })
  assert.equal(r.ask, false)
  assert.equal(r.reason, 'not-running')
})

test('等用户、等后台命令这类能解释的等待不问', () => {
  for (const wait of [
    { kind: 'answer' as const, n: 1 },
    { kind: 'confirm' as const, n: 1 },
    { kind: 'background' as const, n: 1 },
    { kind: 'helpers' as const, list: ['子任务'] },
    { kind: 'workflow' as const },
  ]) {
    const r = ask({ minutes: 3, working: true, lastActivityAt: at(now - 3600_000), wait })
    assert.equal(r.ask, false, `${wait.kind} 不该问`)
    assert.equal(r.reason, 'waiting')
  }
})

test('同一个静默期里每隔阈值才问一次', () => {
  const autoAsk = { at: at(now - 2000), count: 1 }
  const r = ask({ minutes: 3, working: true, lastActivityAt: at(now - 60_000), autoAsk })
  assert.equal(r.ask, false)
  assert.equal(r.reason, 'too-soon')
  assert.equal(r.idleMs, 2000)
  // 询问本身把最后活动时间刷新成询问时间时，也从询问时间往后算
  const same = ask({ minutes: 3, working: true, lastActivityAt: autoAsk.at, autoAsk })
  assert.equal(same.ask, false)
  assert.equal(same.idleMs, 2000)
})

test('问过还是没有输出：满阈值再问，最多 3 次后停手', () => {
  const base = { minutes: 3, working: true, lastActivityAt: at(now - 60_000) }
  assert.equal(ask({ ...base, autoAsk: { at: at(now - 3000), count: 1 } }).count, 2)
  assert.equal(ask({ ...base, autoAsk: { at: at(now - 3000), count: 2 } }).count, CHILD_IDLE_ASK_MAX)
  const over = ask({ ...base, autoAsk: { at: at(now - 3000), count: CHILD_IDLE_ASK_MAX } })
  assert.equal(over.ask, false)
  assert.equal(over.reason, 'limit')
})

test('子对话有了新的输出：次数清零、重新计时', () => {
  const autoAsk = { at: at(now - 10_000), count: CHILD_IDLE_ASK_MAX }
  const r = ask({ minutes: 3, working: true, lastActivityAt: at(now - 3000), autoAsk })
  assert.equal(r.ask, true)
  assert.equal(r.count, 1)
})

test('没有最后活动时间时不猜，按没到阈值处理', () => {
  const r = ask({ minutes: 3, working: true })
  assert.equal(r.ask, false)
  assert.equal(r.reason, 'too-soon')
})

test('询问之后还没有新输出才算「等回复」', () => {
  const autoAsk = { at: at(now), count: 1 }
  assert.equal(childAutoAskWaiting({ autoAsk, lastActivityAt: at(now) }), true)
  assert.equal(childAutoAskWaiting({ autoAsk, lastActivityAt: at(now - 1) }), true)
  assert.equal(childAutoAskWaiting({ autoAsk, lastActivityAt: at(now + 1) }), false)
  assert.equal(childAutoAskWaiting({}), false)
})

test('这一轮收不下、已经撤掉的询问不算在等回复', () => {
  const autoAsk = { at: at(now), count: 1, held: true }
  assert.equal(childAutoAskWaiting({ autoAsk, lastActivityAt: at(now) }), false)
})

test('这一轮说完了、计划没做完也没在等别的：停在等下一句也要问，问够了不再问', () => {
  const plan = (steps: { status: string; waits?: { state: string }[] }[]) =>
    ({
      working: false,
      steps: [],
      plans: [
        {
          id: 'p',
          title: '',
          steps: steps.map((s, i) => ({ id: String(i), title: `第 ${i} 步`, waits: [], children: [], ...s })),
        },
      ],
    }) as unknown as Parameters<typeof planStalled>[0]
  // 用户报过：子对话只回了一句「先跑类型检查」就收尾，计划 1/8，父对话等它、它等下一句
  const stalled = plan([{ status: 'done' }, { status: 'running' }, { status: 'pending' }])
  assert.equal(planStalled(stalled), true)
  // 在等孙对话、已经请父对话收尾、计划做完了：是在等别人，不算停住
  assert.equal(planStalled(plan([{ status: 'done' }, { status: 'waiting', waits: [{ state: 'waiting' }] }])), false)
  assert.equal(
    planStalled({ ...stalled, wrapRequest: { state: 'requested', at: '', note: '' } } as typeof stalled),
    false,
  )
  assert.equal(planStalled(plan([{ status: 'done' }])), false)
  assert.equal(planStalled({ ...stalled, working: true }), false)

  const lastActivityAt = at(now - 3000)
  assert.equal(ask({ minutes: 3, working: false, stalledPlan: true, lastActivityAt }).ask, true)
  // 每次问完它回一句又收尾：次数不清零，问满上限就停，不会每隔几分钟问下去
  const asked = { at: at(now - 4000), count: CHILD_IDLE_ASK_MAX }
  const r = ask({ minutes: 3, working: false, stalledPlan: true, lastActivityAt: at(now - 3500), autoAsk: asked })
  assert.equal(r.reason, 'limit')
})
