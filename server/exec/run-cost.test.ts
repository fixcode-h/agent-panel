import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '../../shared/schema.ts'
import type { ModelCatalogEntry } from '../../shared/models/catalog.ts'
import { turnCost } from './run-cost.ts'

const task = () => ({ usage: { agents: {}, inputTokens: 0, outputTokens: 0, costUsd: 0 } }) as unknown as Task
const entry = (vendor: string, price?: ModelCatalogEntry['price']) => ({ vendor, id: 'm', price }) as ModelCatalogEntry

test('续接会话：新进程第一次报的累计减去上次记下的，不重复记；同一进程里接着做差', () => {
  const tk = task()
  const a = entry('anthropic')
  // 第一个进程：会话 s1 两轮，累计 1.0 → 1.5
  assert.equal(turnCost(tk, { type: 'usage', addCost: 1, costTotal: 1, costSession: 's1' }, a), 1)
  assert.equal(turnCost(tk, { type: 'usage', addCost: 0.5, costTotal: 1.5, costSession: 's1' }, a), 0.5)
  // 续接的新进程从 0 做差，addCost 是整个累计 1.8；只该记 0.3
  assert.ok(Math.abs(turnCost(tk, { type: 'usage', addCost: 1.8, costTotal: 1.8, costSession: 's1' }, a) - 0.3) < 1e-9)
})

test('非 Anthropic 模型不信 CLI 的费用：按填的单价算，没填记 0', () => {
  const ev = {
    type: 'usage' as const,
    addInput: 1_000_000,
    addOutput: 1_000_000,
    addCost: 9,
    costTotal: 9,
    costSession: 's',
  }
  assert.equal(turnCost(task(), ev, entry('deepseek')), 0)
  const price = { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.5 }
  assert.equal(turnCost(task(), ev, entry('deepseek', price)), 2.5)
})

test('CLI 不报费用（Codex 等）时照旧按单价折算', () => {
  const price = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
  assert.equal(turnCost(task(), { type: 'usage', addInput: 1_000_000 }, entry('anthropic', price)), 1)
})
