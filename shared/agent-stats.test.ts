/**
 * Agent 流程数据（扩展 4）：从任务裁精简行、按角色汇总、返工最多的对话。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFlowBriefs } from './agent-flow-briefs.ts'
import { agentStats, flowHotspots, type FlowBrief } from './agent-stats.ts'
import { Task } from './schema.ts'

const at = (min: number) => new Date(Date.UTC(2026, 10, 11, 8, 0) + min * 60_000).toISOString()
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({
    id,
    projectId: 'p',
    title: id,
    mode: 'chat',
    status: 'done',
    createdAt: at(0),
    updatedAt: at(0),
    ...extra,
  })

test('裁剪：只算项目里的 Agent 模式对话，Chat 页的和回收站里的（含顶层对话被删的）不算；子对话记下要打开的顶层对话', () => {
  const briefs = agentFlowBriefs(
    [
      task('top', { agentId: 'orch' }),
      task('mid', { parentTaskId: 'top', rootTaskId: 'top' }),
      task('deep', { parentTaskId: 'mid', rootTaskId: 'top' }),
      task('chat', { projectId: '' }),
      task('gone', { deletedAt: at(5) }),
      task('orphan', { parentTaskId: 'gone' }),
    ],
    Date.parse(at(60)),
  )
  assert.deepEqual(
    briefs.map((b) => [b.id, b.rootId, b.paneId]),
    [
      ['top', '', 'top'],
      ['mid', 'top', 'mid'],
      ['deep', 'top', 'mid'],
    ],
  )
  assert.equal(briefs[0].agentId, 'orch')
})

const FROM = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 }

test('裁剪：推进次数、交代结束、评审退回、合回失败、等你时长和 token 都取面板记下的事实', () => {
  const [b] = agentFlowBriefs(
    [
      task('kid', {
        parentTaskId: 'top-missing',
        resolved: true,
        driveCount: { key: 'k', n: 1, input: '', total: 4 },
        turns: [
          { id: 'a', title: 'x', status: 'done', startedAt: at(0), endedAt: at(1), from: FROM },
          { id: 'b', title: 'y', status: 'done', startedAt: at(2), endedAt: at(3), from: FROM },
        ],
        turnEnds: [
          { at: at(1), outcome: 'blocked', need: '等用户' },
          { at: at(3), outcome: 'done' },
          { at: at(4), outcome: 'done' },
        ],
        steps: [{ id: 's1', title: '实现', kind: 'agent', reviews: 2, rounds: 3, verdict: 'pass' }],
        messages: [
          { id: 'm1', role: 'user', text: '【父对话收尾】没能合回原分支：冲突', at: at(5) },
          { id: 'm2', role: 'user', text: '接着做', at: at(6) },
        ],
        waitMs: 90_000,
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5 },
      }),
    ],
    Date.parse(at(60)),
  )
  assert.equal(b.drives, 4)
  assert.equal(b.turns, 2)
  assert.deepEqual(b.ends, { done: 2, blocked: 1 })
  assert.equal(b.reviewRejects, 2)
  assert.equal(b.mergeFails, 1)
  assert.equal(b.merged, true)
  assert.equal(b.waitMs, 90_000)
  assert.equal(b.tokens, 1200)
  assert.equal(b.costUsd, 0.5)
})

const brief = (id: string, more: Partial<FlowBrief> = {}): FlowBrief => ({
  id,
  title: id,
  projectId: 'p',
  parentTaskId: '',
  rootId: '',
  paneId: id,
  agentId: '',
  createdAt: at(0),
  updatedAt: at(0),
  bug: false,
  drives: 0,
  turns: 1,
  ends: { done: 1, blocked: 0 },
  reviewRejects: 0,
  mergeFails: 0,
  merged: false,
  waitMs: 0,
  tokens: 100,
  costUsd: 0,
  ...more,
})

test('汇总：没有样本的比例和平均是 undefined，不写成 0', () => {
  const s = agentStats([])
  assert.equal(s.total, 0)
  assert.equal(s.avgDrives, undefined)
  assert.equal(s.blockedRate, undefined)
  assert.equal(s.mergeFirstRate, undefined)
  assert.equal(s.avgWaitMs, undefined)
  assert.deepEqual(s.roles, [])
})

test('汇总：一次合回只看合回过的子对话，平均等待只按等过你的对话算；按角色返工多的在前', () => {
  const s = agentStats([
    brief('top', { agentId: 'orch', drives: 3, waitMs: 60_000, ends: { done: 1, blocked: 1 } }),
    brief('k1', { parentTaskId: 'top', agentId: 'worker', merged: true, reviewRejects: 1 }),
    brief('k2', { parentTaskId: 'top', agentId: 'worker', merged: true, mergeFails: 2, drives: 1 }),
    brief('k3', { parentTaskId: 'top', agentId: 'worker', waitMs: 180_000 }),
  ])
  assert.equal(s.total, 4)
  assert.equal(s.tops, 1)
  assert.equal(s.children, 3)
  assert.equal(s.drives, 4)
  assert.equal(s.avgDrives, 1)
  assert.equal(s.endDone, 4)
  assert.equal(s.endBlocked, 1)
  assert.equal(s.blockedRate, 0.2)
  assert.equal(s.reviewRejects, 1)
  assert.equal(s.rejectedConvs, 1)
  assert.equal(s.mergeFails, 2)
  assert.equal(s.mergedKids, 2)
  assert.equal(s.mergeFirstRate, 0.5)
  assert.equal(s.waitedConvs, 2)
  assert.equal(s.avgWaitMs, 120_000)
  assert.equal(s.tokens, 400)
  assert.equal(s.avgTokens, 100)
  assert.deepEqual(
    s.roles.map((r) => [r.agentId, r.convs, r.drives, r.reviewRejects, r.mergeFails]),
    [
      ['worker', 3, 1, 1, 2],
      ['orch', 1, 3, 0, 0],
    ],
  )
})

test('返工最多的对话：先按返工，再按推进次数；既没返工也没被推过的不列', () => {
  const hot = flowHotspots([
    brief('quiet'),
    brief('pushed', { drives: 5 }),
    brief('rejected', { reviewRejects: 1 }),
    brief('both', { reviewRejects: 1, mergeFails: 1 }),
  ])
  assert.deepEqual(
    hot.map((x) => x.id),
    ['both', 'rejected', 'pushed'],
  )
  assert.equal(flowHotspots([brief('a', { drives: 1 }), brief('b', { drives: 2 })], 1).length, 1)
})
