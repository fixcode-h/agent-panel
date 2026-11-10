/**
 * 对话自己的用量上限和用量速率提醒（分析稿 A6）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetFor, budgetNote } from './budget.ts'
import { addSample, rateNote, rateSpike, RATE_WINDOW_MS, treeRunMs, type RateSample } from './budget-rate.ts'
import { setLang } from './i18n.ts'

setLang('zh')
const MIN = 60_000

test('上限：对话单独设了就用它（提醒里说「这个对话设的」），没设用项目的', () => {
  const project = { budget: { tokens: 1_000_000, costUsd: 0 } }
  assert.deepEqual(budgetFor({}, project), { budget: project.budget, own: false })
  assert.deepEqual(budgetFor({ convBudget: { tokens: 0, costUsd: 0 } }, project), {
    budget: project.budget,
    own: false,
  })
  const own = { tokens: 0, costUsd: 2 }
  assert.deepEqual(budgetFor({ convBudget: own }, project), { budget: own, own: true })
  assert.match(budgetNote('warn', { tokens: 0, costUsd: 1.7 }, own, true), /这个对话设的上限的 85%/)
  assert.match(budgetNote('warn', { tokens: 0, costUsd: 1.7 }, own), /项目设的上限/)
})

test('执行时间按整棵对话树加起来，正在跑的那一段算到现在', () => {
  const now = Date.parse('2026-11-10T01:00:00Z')
  const tasks = [
    { id: 'r', runMs: 5 * MIN },
    { id: 'k', parentTaskId: 'r', runMs: MIN, runStartedAt: '2026-11-10T00:58:00Z' },
    { id: 'x', runMs: 99 * MIN },
  ]
  assert.equal(treeRunMs('r', tasks, now), 8 * MIN)
})

/** 每分钟一个样本：前 n1 分钟每分钟 r1 token，之后 n2 分钟每分钟 r2 token（一直在跑） */
function series(n1: number, r1: number, n2: number, r2: number): RateSample[] {
  let list: RateSample[] = []
  let tokens = 0
  for (let i = 1; i <= n1 + n2; i++) {
    tokens += i <= n1 ? r1 : r2
    list = addSample(list, { at: i * MIN, tokens, runMs: i * MIN })
  }
  return list
}

test('速率提醒：最近 10 分钟超过平均 3 倍、量也够大才报', () => {
  const hit = rateSpike(series(30, 20_000, 10, 100_000))
  assert.ok(hit, '平时每分钟 2 万，最近每分钟 10 万')
  assert.equal(hit.tokens, 1_000_000)
  assert.equal(hit.minutes, 10)
  assert.ok(hit.factor >= 3)
  assert.match(rateNote(hit), /最近 10 分钟.*1\.0M token.*5 倍/)
  assert.equal(rateSpike(series(30, 20_000, 10, 50_000)), undefined, '2.5 倍不到 3 倍')
  assert.equal(rateSpike(series(30, 1_000, 10, 20_000)), undefined, '20 倍但 10 分钟只有 20 万，量太小')
  assert.equal(rateSpike(series(5, 20_000, 10, 200_000)), undefined, '刚开始的对话：窗口之前跑得不够久')
})

test('样本只留到窗口开始之前的那一个；中间很久没样本时不判', () => {
  const list = series(40, 10_000, 0, 0)
  assert.equal(list[0].at, list.at(-1)!.at - RATE_WINDOW_MS)
  const old = [
    { at: 0, tokens: 0, runMs: 0 },
    { at: 20 * MIN, tokens: 100_000, runMs: 20 * MIN },
    { at: 80 * MIN, tokens: 5_000_000, runMs: 30 * MIN },
  ]
  assert.equal(rateSpike(old), undefined, '基线是一个小时前的，不算「最近」')
})
