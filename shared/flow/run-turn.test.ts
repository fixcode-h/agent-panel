/**
 * 工作流运行交回父对话的结论（shared/flow/run-turn.ts 的 lastSubmittedSummary）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskStep } from '../schema.ts'
import { lastSubmittedSummary } from './run-turn.ts'

const step = (o: Partial<TaskStep>) => ({ status: 'done', parentId: '', endedAt: '', ...o }) as TaskStep

test('交回的结论用最后做完的节点用工具交的总结，不用开头的过程话', () => {
  const steps = [
    step({ id: 'a', endedAt: '2026-11-22T01:00:00Z', submitted: { summary: '方案定了' } as never }),
    step({ id: 'b', endedAt: '2026-11-22T02:00:00Z', submitted: { summary: '测试全过，可以合回' } as never }),
    step({ id: 'c', parentId: 'b', endedAt: '2026-11-22T03:00:00Z', submitted: { summary: '子节点' } as never }),
  ]
  assert.equal(lastSubmittedSummary(steps), '测试全过，可以合回')
  const reported = [
    step({ id: 'd', submitted: { summary: '', reports: [{ report: { summary: '报告结论' } }] } as never }),
  ]
  assert.equal(lastSubmittedSummary(reported), '报告结论')
  assert.equal(lastSubmittedSummary([step({ id: 'e' })]), '')
})
