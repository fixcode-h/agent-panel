import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// /data 会读设置和日志：数据目录换成临时目录，不碰真实的用户数据
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-memory-'))
process.env.AGENT_PANEL_DATA = dir

const { Hono } = await import('hono')
const { memorySampler, childMemory } = await import('./memory.ts')
const { dataApi } = await import('./data.ts')
const { MemoryUsage, DataUsage } = await import('../shared/data.ts')

const SAMPLE = {
  at: '2025-01-01T10:00:00.000Z',
  rss: 120e6,
  heapTotal: 96e6,
  heapUsed: 64e6,
  external: 4e6,
  arrayBuffers: 2e6,
  running: 1,
  child: 300e6,
}
const snapshot = MemoryUsage.parse({
  memory: SAMPLE,
  samples: [SAMPLE],
  sampling: { intervalMs: 30_000, keepMs: 2 * 3600_000 },
  uptimeMs: 60_000,
  child: { processes: 1, bytes: 300e6 },
  scale: { tasks: 2, chats: 1, projects: 1, running: 1 },
})
const fake = {
  start: () => {},
  stop: () => {},
  sample: async () => SAMPLE,
  snapshot: async () => snapshot,
}
const app = () => new Hono().route('/data', dataApi({ running: () => 0, memory: fake }))

test('采样器按间隔真的采多次：每个点的时间和数值都是新的快照', async () => {
  const sampler = memorySampler(
    { running: () => 1, scale: async () => ({ tasks: 3, chats: 1, projects: 1 }) },
    { intervalMs: async () => 30 },
  )
  sampler.start()
  await new Promise((r) => setTimeout(r, 140))
  sampler.stop()
  const u = await sampler.snapshot()
  assert.ok(u.samples.length >= 2, `只采到 ${u.samples.length} 个点，定时器没在跑`)
  assert.equal(new Set(u.samples.map((s) => s.at)).size, u.samples.length, '每个点的时间都不一样')
  assert.equal(u.memory.at, u.samples[u.samples.length - 1].at, '最新值就是序列的最后一个')
  assert.ok(u.memory.rss > 0, 'RSS 是真实读取的，不会是 0')
  assert.equal(u.memory.running, 1, '采样时带上正在执行的任务数')
  assert.equal(u.scale.tasks, 3)
  assert.equal(u.sampling.intervalMs, 30_000, '没改设置时是默认 30 秒')
  // 结构由 zod 校验，字段少一个会炸
  MemoryUsage.parse(u)
})

test('没有子进程时子进程内存是 0（真的没有），不是读不到', async () => {
  assert.equal(await childMemory([]), 0)
})

test('内存曲线接口只返回采样这块，不遍历数据目录', async () => {
  const res = await app().request('/data/memory')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), snapshot)
})

test('数据页接口带上内存采样和各类占用', async () => {
  const res = await app().request('/data')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.memory, SAMPLE)
  assert.equal(body.samples.length, 1)
  assert.equal(body.sampling.intervalMs, 30_000)
  assert.equal(body.child.bytes, 300e6)
  assert.equal(body.kinds.length, 5)
  DataUsage.parse(body)
})
