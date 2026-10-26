import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemoryPoint, TaskProcess } from './schema.ts'
import { setLang } from './i18n.ts'
import {
  clipReport,
  ownersOf,
  ownerMemoryText,
  taskMemoryReport,
  taskMemoryTrend,
  taskTrendText,
} from './memory-analysis.ts'

// 趋势文案是界面文案：固定中文，不跟着本机语言走
setLang('zh')

const MB = 1024 * 1024
const T0 = Date.parse('2025-01-01T10:00:00.000Z')
/** 一分钟一个点，值按分钟数函数给：total 只算这个对话的 CLI，面板内存不混进合计 */
const series = (n: number, at: (minute: number) => { cli: number | null; server: number }) =>
  Array.from({ length: n }, (_, i) => {
    const { cli, server } = at(i)
    return { t: T0 + i * 60_000, server, cli, total: cli }
  }) satisfies MemoryPoint[]

test('趋势：持续上涨判成 up，平稳和回落分开', () => {
  // 每分钟涨 4 MB：20 分钟涨 80 MB，超过 5% 和 2 MB 的门槛
  const up = series(20, (i) => ({ cli: (100 + i * 4) * MB, server: 200 * MB }))
  const tr = taskMemoryTrend(up)!
  assert.equal(tr.trend, 'up')
  assert.equal(tr.samples, 20)
  assert.equal(tr.delta, 19 * 4 * MB)
  assert.equal(tr.cliDelta, 19 * 4 * MB)
  assert.equal(tr.serverDelta, 0)
  assert.equal(tr.peak.total, (100 + 19 * 4) * MB)

  const flat = series(20, () => ({ cli: 100 * MB, server: 200 * MB }))
  assert.equal(taskMemoryTrend(flat)!.trend, 'flat')

  const down = series(20, (i) => ({ cli: (100 - i * 4) * MB, server: 200 * MB }))
  const dt = taskMemoryTrend(down)!
  assert.equal(dt.trend, 'down')
  assert.ok(dt.delta < 0)
})

test('趋势：点不够、跨度太短、合计未采集时不乱下结论', () => {
  assert.equal(taskMemoryTrend([]), null)
  assert.equal(taskMemoryTrend(series(1, () => ({ cli: 100 * MB, server: 200 * MB }))), null)
  // 只有 2 个点、跨度 2 分钟：不到最短跨度，判成平稳
  const short = series(2, (i) => ({ cli: (100 + i * 50) * MB, server: 200 * MB }))
  assert.equal(taskMemoryTrend(short)!.trend, 'flat')
  // cli 未采集（total 为 null）的点跳过；全是未采集时没有趋势
  const unknown = series(3, () => ({ cli: null, server: 200 * MB }))
  assert.equal(taskMemoryTrend(unknown), null)
  // 只有头尾各一个能用的点也照样算，中间的缺口不影响判断
  const gaps: MemoryPoint[] = [
    { t: T0, server: 200 * MB, cli: 100 * MB, total: 100 * MB },
    { t: T0 + 60_000, server: 200 * MB, cli: null, total: null },
    { t: T0 + 3600_000, server: 200 * MB, cli: 400 * MB, total: 400 * MB },
  ]
  const gt = taskMemoryTrend(gaps)!
  assert.equal(gt.trend, 'up')
  assert.equal(gt.samples, 2)
})

test('趋势文案：涨、降、平各有一句话，采样不足时明说', () => {
  const up = taskMemoryTrend(series(20, (i) => ({ cli: (100 + i * 4) * MB, server: 200 * MB })))
  assert.match(taskTrendText(up), /持续上涨/)
  const down = taskMemoryTrend(series(20, (i) => ({ cli: (100 - i * 4) * MB, server: 200 * MB })))
  assert.match(taskTrendText(down), /回落/)
  const flat = taskMemoryTrend(series(20, () => ({ cli: 100 * MB, server: 200 * MB })))
  assert.match(taskTrendText(flat), /基本平稳/)
  assert.match(taskTrendText(null), /采样还太少/)
})

const proc = (pid: number, ownerTaskId: string, rss: number | null, extra: Partial<TaskProcess> = {}) =>
  ({
    pid,
    parentPid: null,
    command: `cmd ${pid}`,
    ownerTaskId,
    ownerTitle: ownerTaskId ? `对话 ${ownerTaskId}` : '',
    startedAt: T0,
    durationMs: 60_000,
    rss,
    status: 'running',
    kind: 'cli',
    ...extra,
  }) satisfies TaskProcess

test('归属：每个子对话只算自己起的进程树，读不到的记未采集，不平摊', () => {
  const groups = ownersOf(
    [
      proc(1, 'root', 100 * MB),
      proc(2, 'root', 20 * MB, { kind: 'child', parentPid: 1 }),
      proc(3, 'kid-a', 60 * MB),
      // 子对话的 MCP 子进程：归属于子对话自己，算进 kid-a
      proc(4, 'kid-a', 10 * MB, { kind: 'child', parentPid: 3 }),
      // 读不到内存的进程：不能当成 0
      proc(5, 'kid-b', null),
      // 面板自己的动作（AI 创建、文档），没有归属对话
      proc(6, '', 8 * MB, { ownerTitle: '' }),
    ],
    'root',
  )
  assert.deepEqual(
    groups.map((g) => [g.taskId, g.self, g.rss, g.count, g.counted]),
    [
      ['root', true, 120 * MB, 2, 2],
      ['kid-a', false, 70 * MB, 2, 2],
      ['', false, 8 * MB, 1, 1],
      ['kid-b', false, null, 1, 0],
    ],
  )
  // 行上的标题来自服务端登记；没有归属对话的那组显示「面板」，不是拉一个别的对话来顶
  assert.equal(groups[0].title, '对话 root')
  // 没有归属标题的组留空，界面自己写「面板自己的进程」（不把别的对话拉来顶）
  assert.equal(groups[2].title, '')
  // 未采集读不到就是 null，界面上明说，不写成 0 B
  assert.equal(ownerMemoryText(groups[3]), '未采集')
  assert.equal(ownerMemoryText(groups[0]), '120.0 MB')
  // 合计不会把「对不上归属」的进程算进任何一个对话
  const total = groups.filter((g) => g.taskId).reduce((n, g) => n + (g.rss ?? 0), 0)
  assert.equal(total, 190 * MB)
})

test('报告：两路内存、趋势、归属、任务树和上下文都在，未采集不写成 0', () => {
  const points = series(20, (i) => ({ cli: (100 + i * 4) * MB, server: 200 * MB }))
  const owners = ownersOf([proc(1, 'root', 176 * MB), proc(2, 'kid-a', 92 * MB), proc(3, 'kid-b', null)], 'root')
  const report = taskMemoryReport({
    task: { title: '整理模块结构', mode: 'chat', status: 'running' },
    project: { name: 'agent-panel', path: 'E:/Project/agent-panel' },
    points,
    intervalMs: 30_000,
    panel: { cliMemory: 176 * MB, serverMemory: 200 * MB, unavailable: '' },
    owners,
    tree: { tasks: 3, children: 2, running: 1 },
    contexts: [
      { id: 'root', title: '整理模块结构', context: 48_000, window: 200_000, self: true },
      { id: 'kid-a', title: '子对话 A', context: 62_000, window: 200_000, self: false },
    ],
  })
  assert.match(report, /会话内存分析/)
  assert.match(report, /「整理模块结构」/)
  assert.match(report, /E:\/Project\/agent-panel/)
  assert.match(report, /合计/)
  assert.match(report, /会话合计 176\.0 MB/)
  assert.match(report, /面板进程 200\.0 MB（不计入会话合计）/)
  assert.match(report, /趋势/)
  assert.match(report, /持续上涨/)
  assert.match(report, /进程归属/)
  assert.match(report, /本对话「对话 root」/)
  // 读不到的进程写成未采集，不能出现「0 B」
  assert.match(report, /未采集（1 个进程都没读到内存，不是 0）/)
  assert.match(report, /任务树：本对话 \+ 2 个子对话，共 3 个任务，其中 1 个正在执行/)
  assert.match(report, /48\.0k \/ 200\.0k tokens/)
  assert.match(report, /子对话合计 62\.0k tokens/)

  // 没有项目、没有采样时也说得清楚
  const empty = taskMemoryReport({
    task: { title: '还没开始的对话', mode: 'chat', status: 'idle' },
    project: null,
    points: [],
    intervalMs: 30_000,
    panel: { cliMemory: null, serverMemory: 268 * MB, unavailable: '取不到系统进程信息' },
    owners: [],
    tree: { tasks: 1, children: 0, running: 0 },
    contexts: [],
  })
  assert.match(empty, /还没有读到内存采样/)
  assert.match(empty, /采样点太少/)
  assert.match(empty, /这个会话现在没有在跑的进程/)
  // 没有项目时不写空的项目行
  assert.ok(!empty.includes('项目：'))

  // 太长时截断，但保留开头
  const long = clipReport('x'.repeat(9000))
  assert.ok(long.length < 9000)
  assert.match(long, /报告太长/)
})
