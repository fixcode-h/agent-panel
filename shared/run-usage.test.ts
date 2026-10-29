import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentUsage, StepUsage, Task, TaskStep } from './schema.ts'
import { contextBreakdown, tokensOfChars } from './context-breakdown.ts'
import { getCli } from './clis.ts'
import { helperSteps, ownTokens, runTree, runUsage, subtreeTaskIds, tokenCount, tokensOf, tpsNow } from './run-usage.ts'

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
    status?: Task['status']
  } = {},
) =>
  ({
    id,
    parentTaskId: opts.parentTaskId,
    status: opts.status ?? 'running',
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

/** 会话栏的上下文细分：同一份用量的另一种拆法（按块拆一个会话的上下文窗口），各块加起来要等于 CLI 报的总数 */
function checkContextBreakdown() {
  const parts = {
    cli: 'pi',
    system: 3000,
    tools: [
      { name: 'ask_user', chars: 1800 },
      { name: 'spawn_agents', chars: 3600 },
    ],
    deferred: [{ name: 'record_lesson', chars: 900 }],
  }
  const files = { memory: [{ path: 'AGENTS.md', chars: 6000 }], skills: [{ name: 'docs', chars: 300 }] }
  const base = getCli('pi')!.context
  const d = contextBreakdown({ used: 60_000, window: 200_000, base, parts, files, autoCompactPct: 70 })
  const of = (k: string) => d.rows.find((r) => r.key === k)?.tokens ?? 0
  // 窗口里的各块（含余量、空闲）加起来正好是窗口；消息 = 总占用 − 其余
  assert.equal(
    d.rows.reduce((n, r) => n + r.tokens, 0),
    200_000,
  )
  assert.equal(of('mcpTools'), tokensOfChars(1800) + tokensOfChars(3600))
  assert.equal(of('systemPrompt'), base!.systemPrompt! + tokensOfChars(3000))
  assert.equal(of('memory'), 2000)
  assert.equal(
    of('messages'),
    60_000 - of('systemTools') - of('mcpTools') - of('systemPrompt') - of('skills') - of('memory'),
  )
  // 面板设了 70% 自动压缩：余量是窗口的 30%，空闲是剩下的
  assert.equal(of('buffer'), 60_000)
  assert.equal(of('free'), 80_000)
  assert.equal(Math.round(d.percent), 30)
  // 按需取用的工具单列，不画进窗口
  assert.deepEqual(d.deferred, [{ key: 'mcpDeferred', tokens: tokensOfChars(900) }])
  assert.equal(d.tools.length + d.deferredTools.length, 3)

  // 刚开会话、估的比报的还多：按比例缩到总占用以内，消息记 0，不会出现负数
  const tiny = contextBreakdown({ used: 1000, window: 200_000, base, parts, files })
  assert.ok(tiny.rows.every((r) => r.tokens >= 0))
  assert.ok(tiny.rows.filter((r) => !['buffer', 'free'].includes(r.key)).reduce((n, r) => n + r.tokens, 0) <= 1000)
  // 没设自动压缩百分比：用 CLI 自己的余量（Pi 16384），标成估计值
  const buffer = tiny.rows.find((r) => r.key === 'buffer')
  assert.equal(buffer?.tokens, 16384)
  assert.equal(buffer?.estimated, true)
  // Codex 按窗口的一成留余量
  const codex = contextBreakdown({ used: 0, window: 100_000, base: getCli('codex')!.context })
  assert.equal(codex.rows.find((r) => r.key === 'buffer')?.tokens, 10_000)
}

test('整个运行：总数 = 父对话 + 所有子对话（含多层）+ 派出的子任务', () => {
  checkContextBreakdown()
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
  // 只有 a1 在输出：helper 和 c2 虽然留着 lastTps，已经停下就不贡献速度
  assert.equal(run.tps, 50)
  assert.equal(run.runTps, 70)
  // 子任务与子对话只算在跑的那几个（c1 的 20）
  assert.equal(run.subTps, 20)
  // 两层的速度加起来一定等于整体
  assert.equal(run.tps + run.subTps, run.runTps)

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

test('子树 id：只含自己、后代，不含父对话和兄弟；脏数据成环也能结束', () => {
  const all = [
    task('p1'),
    task('c1', { parentTaskId: 'p1' }),
    task('g1', { parentTaskId: 'c1' }),
    task('c2', { parentTaskId: 'p1' }),
    task('other'),
    task('o1', { parentTaskId: 'other' }),
    task('loopA', { parentTaskId: 'loopB' }),
    task('loopB', { parentTaskId: 'loopA' }),
  ]
  // 子对话只到自己这一支，父对话和兄弟都不在里面
  assert.deepEqual([...subtreeTaskIds(all, 'c1')].sort(), ['c1', 'g1'])
  assert.deepEqual([...subtreeTaskIds(all, 'p1')].sort(), ['c1', 'c2', 'g1', 'p1'])
  assert.deepEqual([...subtreeTaskIds(all, 'other')].sort(), ['o1', 'other'])
  // 互相指向的脏数据不会转不出来
  assert.deepEqual([...subtreeTaskIds(all, 'loopA')].sort(), ['loopA', 'loopB'])
  // 列表里没有自己、也没有后代时就是自己
  assert.deepEqual([...subtreeTaskIds([], 'x')], ['x'])
})

test('速度：只算正在输出的，混着 lastTps 也不冒充实时', () => {
  const t = task('p1', { agents: { a1: agent(10, 8), a2: agent(0, 5) } })
  assert.equal(tpsNow(t), 10)
  assert.equal(tpsNow(t, ['a2']), 0)
  assert.equal(tpsNow(t, []), 0)
  // 已经结束的任务不算速度：面板重启前留下的 tps 不是「现在」的速度
  assert.equal(tpsNow(task('p1', { status: 'done', agents: { a1: agent(10, 8) } })), 0)
  assert.equal(tpsNow(task('p1', { status: 'stopped', agents: { a1: agent(10, 8) } })), 0)
})

test('速度：全都空闲时整体和分层都是 0，不留上一条的残值', () => {
  // 三条都停下来了，但各自都留着上一轮最后一次的速度
  const idle = task('p1', {
    steps: [step('n1', '', u(100, 10), 'a1'), step('n1/sub/h1', 'sub', u(20, 2), 'helper')],
    usage: { inputTokens: 120, outputTokens: 12 },
    agents: { a1: agent(0, 900), helper: agent(0, 2041.7) },
  })
  const child = task('c1', { parentTaskId: 'p1', agents: { a2: agent(0, 3000) } })
  const run = runUsage(idle, [idle, child])
  assert.equal(run.tps, 0)
  assert.equal(run.subTps, 0)
  assert.equal(run.runTps, 0)
})

test('速度：只有父对话在写时整体等于父对话，子任务与子对话那层是 0', () => {
  const writing = task('p1', {
    steps: [step('n1', '', u(100, 10), 'a1'), step('n1/sub/h1', 'sub', u(20, 2), 'helper')],
    usage: { inputTokens: 120, outputTokens: 12 },
    agents: { a1: agent(42, 42), helper: agent(0, 2041.7) },
  })
  // 子对话已经停下，lastTps 还挂着 3000
  const stopped = task('c1', { parentTaskId: 'p1', agents: { a2: agent(0, 3000) } })
  const run = runUsage(writing, [writing, stopped])
  assert.equal(run.tps, 42)
  assert.equal(run.subTps, 0)
  assert.equal(run.runTps, 42)
})

test('速度：父对话空闲、子对话在写时整体等于子对话，本对话那层是 0', () => {
  const idle = task('p1', {
    steps: [step('n1', '', u(100, 10), 'a1')],
    usage: { inputTokens: 100, outputTokens: 10 },
    agents: { a1: agent(0, 800) },
  })
  const writing = task('c1', { parentTaskId: 'p1', agents: { a2: agent(17, 17) } })
  const alsoWriting = task('c2', { parentTaskId: 'c1', agents: { a3: agent(5, 0) } })
  const run = runUsage(idle, [idle, writing, alsoWriting])
  assert.equal(run.tps, 0)
  assert.equal(run.subTps, 22)
  assert.equal(run.runTps, 22)
})

test('速度：三层都在写时各算各的，加起来等于整体', () => {
  const t = task('p1', {
    steps: [step('n1', '', u(100, 10), 'a1'), step('n1/sub/h1', 'sub', u(20, 2), 'helper')],
    usage: { inputTokens: 120, outputTokens: 12 },
    agents: { a1: agent(10, 10), helper: agent(7, 7) },
  })
  const child = task('c1', { parentTaskId: 'p1', agents: { a2: agent(5, 5) } })
  const run = runUsage(t, [t, child])
  assert.equal(run.tps, 10)
  assert.equal(run.subTps, 7 + 5)
  assert.equal(run.runTps, 22)
})

test('速度：对话自己的 Agent 没挂在节点上也算本对话', () => {
  // 对话的一轮不是节点，只有派出的子任务会挂成 slot: sub：只按步骤分的话对话自己的速度会整个丢掉
  const chat = task('p1', {
    steps: [step('@chat/sub/h1', 'sub', u(20, 2), 'helper')],
    usage: { inputTokens: 120, outputTokens: 12 },
    agents: { a1: agent(42, 42), helper: agent(0, 2041.7) },
  })
  const run = runUsage(chat, [chat])
  assert.equal(run.tps, 42)
  assert.equal(run.subTps, 0)
  assert.equal(run.runTps, 42)

  // 子任务刚派出去、还没开始写：父子都算在写的
  const both = task('p2', {
    steps: [step('@chat/sub/h1', 'sub', u(20, 2), 'helper')],
    usage: { inputTokens: 120, outputTokens: 12 },
    agents: { a1: agent(10, 10), helper: agent(4, 4) },
  })
  const run2 = runUsage(both, [both])
  assert.equal(run2.tps, 10)
  assert.equal(run2.subTps, 4)
  assert.equal(run2.runTps, 14)
})
