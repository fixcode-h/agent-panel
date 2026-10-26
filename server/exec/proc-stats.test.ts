import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TrackedCli, TrackedOwner } from './orphans.ts'
import type { ProcNode, StoredSample } from './proc-stats.ts'

// 内存历史也在 DATA_DIR 下，必须在 import 之前指到临时目录
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'proc-stats-'))

const {
  aggregateByRoot,
  aggregateByTask,
  cleanableClis,
  commandSummary,
  descendants,
  ownedEntries,
  pushSample,
  subtree,
  sumRss,
  summarize,
  trackedStatus,
} = await import('./proc-stats.ts')

/** [pid, ppid, rss, argv] */
function mapOf(...rows: [number, number, number | null, string?][]) {
  return new Map<number, ProcNode>(
    rows.map(([pid, ppid, rss, argv]) => [pid, { pid, ppid, rss, argv: argv ?? `node cli ${pid}`, startedAt: null }]),
  )
}

const owner = (taskId: string, rootTaskId = 'root'): TrackedOwner => ({ taskId, rootTaskId, title: taskId })

function entry(pid: number, o?: TrackedOwner, extra: Partial<TrackedCli> = {}): TrackedCli {
  return {
    pid,
    argv: `node /x/cache/cli-run/a/b.mjs ${pid}`,
    cwd: '/tmp',
    startedAt: 1_000,
    ...extra,
    ...(o ? { owner: o } : {}),
  }
}

test('进程树：按 ppid 收集整棵树，含自己', () => {
  const map = mapOf([10, 1, 100], [11, 10, 200], [12, 10, 300], [13, 11, 400], [14, 1, 500])
  assert.deepEqual(subtree(10, map), [10, 11, 12, 13])
  assert.deepEqual(subtree(99, map), [])
  // 父 pid 成环也不会转不出来
  const loop = mapOf([1, 2, 10], [2, 1, 20], [3, 1, 30])
  assert.deepEqual(
    subtree(1, loop).sort((a, b) => a - b),
    [1, 2, 3],
  )
})

test('RSS 合计：只加拿得到的，一个都没有时是不存在（界面显示未知）', () => {
  const map = mapOf([1, 0, 100], [2, 1, null], [3, 1, 50])
  assert.equal(sumRss([1, 2, 3], map), 150)
  assert.equal(sumRss([2], map), null)
  assert.equal(sumRss([], map), null)
})

test('按对话汇总：父子都登记时同一个 pid 只算一次', () => {
  const map = mapOf([10, 1, 100], [11, 10, 200], [12, 11, 300])
  const out = aggregateByRoot([entry(10, owner('a')), entry(11, owner('b'))], map)
  assert.deepEqual(out.get('root'), { rss: 600, pids: 3 })
})

test('按对话汇总：不同对话各算各的，没有归属的登记不参与', () => {
  const map = mapOf([10, 1, 100], [20, 1, 500], [21, 20, 600])
  const out = aggregateByRoot([entry(10, owner('a', 'r1')), entry(20, owner('b', 'r2')), entry(99, undefined)], map)
  assert.deepEqual(out.get('r1'), { rss: 100, pids: 1 })
  assert.deepEqual(out.get('r2'), { rss: 1100, pids: 2 })
  assert.equal(out.size, 2)
})

test('按任务汇总：父任务和子对话各算自己登记的进程，子对话能单独取到', () => {
  const map = mapOf([10, 1, 100], [11, 10, 200], [20, 1, 500])
  const out = aggregateByTask([entry(10, owner('p1', 'p1')), entry(20, owner('c1', 'p1')), entry(99, undefined)], map)
  assert.deepEqual(out.get('p1'), { rss: 300, pids: 2 })
  assert.deepEqual(out.get('c1'), { rss: 500, pids: 1 })
  assert.equal(out.size, 2)
})

test('按任务汇总：父子都登记了同一个 pid 时只算一次', () => {
  const map = mapOf([10, 1, 100], [11, 10, 200])
  const out = aggregateByTask([entry(10, owner('p1', 'p1')), entry(10, owner('c1', 'p1'))], map)
  assert.deepEqual(out.get('p1'), { rss: 300, pids: 2 })
  assert.equal(out.has('c1'), false)
})

test('进程归属：只取当前子树任务的登记，祖先、兄弟和无归属的面板动作都不算', () => {
  const entries = [
    entry(1, owner('p1', 'p1')),
    entry(2, owner('c1', 'p1')),
    entry(3, owner('c2', 'p1')),
    entry(4, owner('g1', 'p1')),
    entry(5, undefined),
  ]
  assert.deepEqual(
    ownedEntries(entries, new Set(['c1', 'g1'])).map((e) => e.owner?.taskId),
    ['c1', 'g1'],
  )
  // 打开子对话：父对话和兄弟的登记都不在列表里
  assert.deepEqual(
    ownedEntries(entries, new Set(['c1'])).map((e) => e.pid),
    [2],
  )
})

test('命令行摘要：临时目录和 MCP 配置换掉，限制长度', () => {
  const out = commandSummary(
    'node C:\\Users\\u\\.agent-panel\\cache\\cli-run\\abc\\panel.mjs --mcp-config {"mcpServers":{}}',
  )
  assert.equal(/cli-run/.test(out), false)
  assert.equal(/mcpServers/.test(out), false)
  assert.equal(out.length < 80, true)
  assert.equal(commandSummary('a'.repeat(300)).endsWith('…'), true)
  assert.equal(commandSummary('pi  --print   你好'), 'pi --print 你好')
})

test('状态：任务在跑是运行中，十分钟没输出是无输出，任务不在是孤儿', () => {
  const now = 10_000_000
  assert.equal(
    trackedStatus(entry(1, owner('t'), { lastOutputAt: now - 1000 }), () => true, now),
    'running',
  )
  assert.equal(
    trackedStatus(entry(1, owner('t'), { lastOutputAt: now - 11 * 60_000 }), () => true, now),
    'idle',
  )
  assert.equal(
    trackedStatus(entry(1, owner('t')), () => false, now),
    'orphan',
  )
  assert.equal(
    trackedStatus(entry(1, undefined), () => true, now),
    'orphan',
  )
})

test('清理白名单：只清任务已经不在跑的、命令行仍像面板起的', () => {
  const alive = new Set(['alive'])
  const aliveTask = (id: string) => alive.has(id)
  const panelArgv = 'node /home/u/.agent-panel/cache/cli-run/x/panel.mjs'
  const map = mapOf([10, 1, 100, panelArgv], [20, 1, 100, panelArgv], [30, 1, 100, 'bash'])
  const { targets, skipped, gone } = cleanableClis({
    entries: [entry(10, owner('alive')), entry(20, owner('dead')), entry(30, owner('dead2'))],
    map,
    aliveTask,
  })
  assert.deepEqual(
    targets.map((x) => x.pid),
    [20],
  )
  assert.deepEqual(
    skipped.map((x) => x.pid),
    [10, 30],
  )
  assert.deepEqual(gone, [])
})

test('清理白名单：只看当前对话及附属的任务登记', () => {
  const panelArgv = 'node /home/u/.agent-panel/cache/cli-run/x/panel.mjs'
  const map = mapOf([10, 1, 100, panelArgv], [20, 1, 100, panelArgv], [30, 1, 100, panelArgv])
  const { targets } = cleanableClis({
    entries: [entry(10, owner('dead', 'other')), entry(20, owner('p1', 'p1')), entry(30, owner('c1', 'p1'))],
    map,
    aliveTask: () => false,
    taskIds: new Set(['p1', 'c1']),
  })
  assert.deepEqual(
    targets.map((x) => x.pid),
    [20, 30],
  )
})

test('清理白名单：进程已经结束的登记进 gone，不在 targets 里', () => {
  const { targets, gone } = cleanableClis({
    entries: [entry(777, owner('dead'))],
    map: mapOf(),
    aliveTask: () => false,
  })
  assert.deepEqual(targets, [])
  assert.deepEqual(gone, [777])
})

test('清理白名单：用户勾选了 pid 就只清这些', () => {
  const panelArgv = 'node /home/u/.agent-panel/cache/cli-run/x/panel.mjs'
  const map = mapOf([10, 1, 100, panelArgv], [20, 1, 100, panelArgv])
  const { targets } = cleanableClis({
    entries: [entry(10, owner('d1')), entry(20, owner('d2'))],
    map,
    aliveTask: () => false,
    only: [20],
  })
  assert.deepEqual(
    targets.map((x) => x.pid),
    [20],
  )
})

test('清理白名单：快照取不到时按登记的命令行判断', () => {
  const { targets } = cleanableClis({ entries: [entry(10, owner('dead'))], map: null, aliveTask: () => false })
  assert.deepEqual(
    targets.map((x) => x.pid),
    [10],
  )
})

const sample = (t: number, cli: number, extra: Partial<StoredSample> = {}): StoredSample => ({
  t,
  server: 1000,
  roots: [{ root: 'r1', rss: cli, pids: 1 }],
  unavailable: false,
  ...extra,
})

test('内存历史：环形缓冲超过容量时丢掉最旧的', () => {
  let list: StoredSample[] = []
  for (let i = 0; i < 5; i++) list = pushSample(list, sample(i, i), 3)
  assert.deepEqual(
    list.map((x) => x.t),
    [2, 3, 4],
  )
})

test('内存历史：合计只算这个对话的 CLI，面板 server 单独给出', () => {
  assert.deepEqual(summarize([sample(1, 500), sample(2, 700)], ['r1']), [
    { t: 1, server: 1000, cli: 500, total: 500 },
    { t: 2, server: 1000, cli: 700, total: 700 },
  ])
  // 新样本里这些任务确实没有进程：0，不是未知
  assert.deepEqual(summarize([sample(1, 0, { roots: [], tasks: [] })], ['other'])[0], {
    t: 1,
    server: 1000,
    cli: 0,
    total: 0,
  })
  // 快照取不到：cli 和 total 都是 null（曲线断开，不掉到 0）
  assert.deepEqual(summarize([sample(1, 0, { roots: [], unavailable: true })], ['r1'])[0], {
    t: 1,
    server: 1000,
    cli: null,
    total: null,
  })
})

test('内存历史：旧样本只有根任务聚合时，子对话是未知而不是 0（不制造 0 起步的假曲线）', () => {
  // 升级前的样本：只有 roots，没有 tasks。子对话 c1 的 id 和 roots 的键对不上
  const old = [sample(1, 500, { roots: [{ root: 'p1', rss: 500, pids: 1 }] })]
  assert.deepEqual(summarize(old, ['c1'])[0], { t: 1, server: 1000, cli: null, total: null })
  // 父对话自己能还原整树，照常给数字
  assert.equal(summarize(old, ['p1'])[0].cli, 500)
  // 旧样本里整台机器都没有进程：子对话也是 0，不是未知
  assert.equal(summarize([sample(1, 0, { roots: [] })], ['c1'])[0].cli, 0)
})

test('内存历史：新采样按任务分开记，子对话只加自己这一支', () => {
  const tasks = (t: number, list: NonNullable<StoredSample['tasks']>) => sample(t, 0, { roots: [], tasks: list })
  const list = [
    tasks(1, [
      { taskId: 'p1', rss: 100, pids: 1 },
      { taskId: 'c1', rss: 40, pids: 1 },
      { taskId: 'c2', rss: 60, pids: 1 },
    ]),
  ]
  // 打开子对话：只有它自己的 40 MB，父对话和兄弟都不算
  assert.equal(summarize(list, new Set(['c1']))[0].cli, 40)
  // 打开父对话：它和全部后代加起来
  assert.equal(summarize(list, new Set(['p1', 'c1', 'c2']))[0].cli, 200)
  // 一个匹配的任务都没有：0，不是未知
  assert.equal(summarize(list, new Set(['x']))[0].cli, 0)
})

test('内存历史：按时间范围裁', () => {
  const list = [sample(1, 1), sample(2, 2), sample(3, 3)]
  assert.deepEqual(
    summarize(list, ['r1'], { from: 2 }).map((x) => x.t),
    [2, 3],
  )
  assert.deepEqual(
    summarize(list, ['r1'], { to: 2 }).map((x) => x.t),
    [1, 2],
  )
})

test('descendants：主进程已经结束、不在进程表里，也按 ppid 找出留下的孙进程（强制停止时补杀它们）', () => {
  // 10 是 CLI（已被结束），20 是它起的 shell，30 是 shell 里还在跑的命令；99 是别人的进程
  const map = mapOf([20, 10, 1], [30, 20, 1], [99, 1, 1])
  assert.deepEqual(descendants(10, map).sort(), [20, 30])
  assert.deepEqual(descendants(99, map), [])
})
