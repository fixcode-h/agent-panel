import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentUsage, StepUsage, Task, TaskStep } from './schema.ts'
import { helperSteps, liveTps, ownTokens, runTree, runUsage, tokenCount, tokensOf } from './run-usage.ts'

/** 节点的用量：只要 token 和费用，上下文那几项给默认值 */
const u = (inputTokens: number, outputTokens: number, costUsd = 0): StepUsage => ({
  context: 0,
  window: 0,
  model: '',
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
})

const step = (id: string, slot: TaskStep['slot'], usage: StepUsage, agentId = '') =>
  ({ id, parentId: '', slot, agentId, usage }) as TaskStep

const agent = (tps: number, lastTps = 0): AgentUsage => ({
  context: 0,
  window: 0,
  model: '',
  tps,
  lastTps,
  outputTokens: 0,
  genMs: 0,
})

/**
 * 一个对话：usage 是任务累计（含它派出的子任务），agents 是各角色的实时速度。
 * 只造用量相关的字段，其它用不到的给空值
 */
const task = (
  id: string,
  opts: {
    steps?: TaskStep[]
    usage?: Partial<Pick<Task['usage'], 'inputTokens' | 'outputTokens' | 'costUsd'>>
    agents?: Task['usage']['agents']
    parentTaskId?: string
  } = {},
) =>
  ({
    id,
    parentTaskId: opts.parentTaskId,
    steps: opts.steps ?? [],
    usage: {
      agents: opts.agents ?? {},
      inputTokens: opts.usage?.inputTokens ?? 0,
      outputTokens: opts.usage?.outputTokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: opts.usage?.costUsd ?? 0,
    },
  }) as Task

/** 父对话：自己跑了一轮，又派了一个子任务（子任务下面还有一步） */
const parent = () =>
  task('p1', {
    steps: [
      step('n1', '', u(1000, 100, 0.5), 'a1'),
      step('n1/sub/h1', 'sub', u(200, 20), 'helper'),
      step('n1/sub/h1/x', 'step', u(50, 5), 'helper'),
    ],
    // 任务累计把派出的子任务也算进去了
    usage: { inputTokens: 1250, outputTokens: 125, costUsd: 0.6 },
    agents: { a1: agent(50, 40), helper: agent(0, 10) },
  })

/** 子对话 c1 和它的子对话 c2：子对话是独立的任务 */
const kids = () => [
  task('c1', { parentTaskId: 'p1', usage: { inputTokens: 400, outputTokens: 40 }, agents: { a2: agent(20) } }),
  task('c2', { parentTaskId: 'c1', usage: { inputTokens: 100, outputTokens: 10 }, agents: { a3: agent(0, 5) } }),
  // 别的运行，不该算进来
  task('other', { usage: { inputTokens: 999, outputTokens: 99 } }),
]

test('整个运行：总数 = 父对话 + 所有子对话（含多层）+ 派出的子任务', () => {
  const run = runUsage(parent(), kids())
  assert.equal(run.children, 2)
  assert.equal(run.helpers, 2)
  // 1250+400+100 / 125+40+10
  assert.deepEqual(run.total, { ...tokensOf({ inputTokens: 1750, outputTokens: 175, costUsd: 0.6 }) })
  // 父对话本身：任务累计减去派出的子任务（200+50 输入、20+5 输出）
  assert.deepEqual(run.own, tokensOf({ inputTokens: 1000, outputTokens: 100, costUsd: 0.6 }))
  // 子任务与子对话 = 总 − 本对话，三项加起来一定等于总数
  assert.equal(tokenCount(run.sub), 750 + 75)
  assert.equal(tokenCount(run.own) + tokenCount(run.sub), tokenCount(run.total))
})

test('整个运行：速度分「本对话」和「整体」，同一个角色只算一次', () => {
  const run = runUsage(parent(), kids())
  // 本对话的 Agent（a1）在输出；helper 没有输出，用它这一轮最后一次的速度
  assert.equal(run.tps, 50)
  // 本对话 50 + 子任务 10 + 子对话 c1 20 + c2 5
  assert.equal(run.runTps, 85)

  // 父子共用一个角色时分不开：算进本对话，整体速度不会因为两处相加而偏大
  const shared = runUsage(
    task('p1', {
      steps: [step('n1', '', u(100, 10), 'a1'), step('n1/sub/h1', 'sub', u(20, 2), 'a1')],
      usage: { inputTokens: 120, outputTokens: 12 },
      agents: { a1: agent(30, 30) },
    }),
    [],
  )
  assert.equal(shared.tps, 30)
  assert.equal(shared.runTps, 30)
})

test('没有子对话和子任务时退化成一份：总数就是本对话，子任务为 0', () => {
  const only = task('p1', {
    steps: [step('n1', '', u(100, 10), 'a1')],
    usage: { inputTokens: 100, outputTokens: 10 },
    agents: { a1: agent(12, 8) },
  })
  const run = runUsage(only, [only])
  assert.equal(run.children, 0)
  assert.equal(run.helpers, 0)
  assert.deepEqual(run.total, run.own)
  assert.equal(tokenCount(run.sub), 0)
  assert.equal(run.runTps, run.tps)
  assert.equal(run.tps, 12)
})

test('任务累计还没赶上子任务的节点用量时不会算出负数', () => {
  // 执行中两个数来自不同时刻：任务累计先涨、节点后写
  const behind = task('p1', {
    steps: [step('n1', '', u(100, 10), 'a1'), step('n1/sub/h1', 'sub', u(80, 8), 'helper')],
    usage: { inputTokens: 100, outputTokens: 10 },
  })
  assert.deepEqual(ownTokens(behind), tokensOf({ inputTokens: 20, outputTokens: 2 }))
  const run = runUsage(behind, [behind])
  // 子任务与子对话 = 总 − 本对话，不会出现负数
  assert.equal(tokenCount(run.sub), 80 + 8)
  const later = task('p1', {
    steps: [step('n1/sub/h1', 'sub', u(180, 18), 'helper')],
    usage: { inputTokens: 100, outputTokens: 10 },
  })
  assert.deepEqual(ownTokens(later), tokensOf({}))
})

test('派出的子任务连同它的子步骤一起算', () => {
  const t = parent()
  assert.deepEqual(
    helperSteps(t).map((s) => s.id),
    ['n1/sub/h1', 'n1/sub/h1/x'],
  )
  assert.equal(helperSteps(task('p1')).length, 0)
})

test('子对话按 parentTaskId 逐层找，不看列表顺序，也不绕圈', () => {
  const all = [...kids(), parent()]
  all.push(task('loop', { parentTaskId: 'loop' }))
  assert.deepEqual(
    runTree(parent(), all).map((x) => x.id),
    ['p1', 'c1', 'c2'],
  )
  // 自己不在列表里也能算（执行中的任务用内存里那一份传进来）
  assert.deepEqual(
    runTree(parent(), kids()).map((x) => x.id),
    ['p1', 'c1', 'c2'],
  )
})

test('速度：正在输出用 tps，都没输出时用这一轮最后一次的', () => {
  const t = task('p1', { agents: { a1: agent(10, 8), a2: agent(0, 5) } })
  assert.equal(liveTps(t), 10)
  assert.equal(liveTps(t, ['a2']), 5)
  assert.equal(liveTps(t, []), 0)
})
