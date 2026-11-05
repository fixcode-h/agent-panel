/**
 * 会话栏「模型响应」的数（first-token.ts）。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstTokenSummary } from './first-token.ts'
import type { AgentUsage } from './schema.ts'

const agent = (over: Partial<AgentUsage>): AgentUsage => ({
  context: 0,
  window: 0,
  model: '',
  tps: 0,
  lastTps: 0,
  outputTokens: 0,
  genMs: 0,
  ...over,
})

test('首包：几个 Agent 合起来算平均、最近平均、最长；没有记录时不显示', () => {
  assert.equal(firstTokenSummary(undefined), null)
  assert.equal(firstTokenSummary({ a: agent({}) }), null, '旧记录没有 firstToken')
  const s = firstTokenSummary({
    a: agent({
      firstToken: { n: 3, sumMs: 6000, maxMs: 3000, recent: [1000, 2000, 3000] },
      outputTokens: 1000,
      genMs: 10_000,
    }),
    b: agent({
      firstToken: { n: 1, sumMs: 10_000, maxMs: 10_000, recent: [10_000] },
      outputTokens: 1000,
      genMs: 10_000,
    }),
  })!
  assert.equal(s.n, 4)
  assert.equal(s.avgMs, 4000)
  assert.equal(s.recentAvgMs, 4000)
  assert.equal(s.maxMs, 10_000)
  assert.equal(s.sumMs, 16_000)
  assert.equal(s.tps, 100)
})
