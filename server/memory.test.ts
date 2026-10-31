import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// /data 会读设置和日志：数据目录换成临时目录，不碰真实的用户数据
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-memory-'))
process.env.AGENT_PANEL_DATA = dir

const { Hono } = await import('hono')
const { memorySampler, childMemory } = await import('./memory.ts')
const { dataApi, readBackupFiles } = await import('./data.ts')
const { MemoryUsage, DataUsage, DATA_KINDS } = await import('../shared/data.ts')

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
  // 服务端只带 Node 类型，Response.json() 是 unknown（DOM 里是 any）；测试按接口约定直接读字段，放宽成 any
  const body: any = await res.json()
  assert.deepEqual(body.memory, SAMPLE)
  assert.equal(body.samples.length, 1)
  assert.equal(body.sampling.intervalMs, 30_000)
  assert.equal(body.child.bytes, 300e6)
  // 分类由 shared/data.ts 的 DATA_KINDS 驱动：对话工作目录单独一类（和任务记录分开），
  // 独立分支不进这份统计（四 GB、十几万个文件，只在清理面板按需算），这里钉住这两点
  assert.ok(
    body.kinds.some((k: { id: string }) => k.id === 'workspace'),
    '对话工作目录要单独一类，不能算进任务记录',
  )
  assert.ok(!body.kinds.some((k: { id: string }) => k.id === 'worktrees'), '独立分支不在 /data 的每次扫描里')
  assert.equal(body.kinds.length, DATA_KINDS.length)
  DataUsage.parse(body)
})

test('导出跳过半截的 .tmp：备份里只有正常文件', async () => {
  const tasks = path.join(dir, 'tasks')
  mkdirSync(tasks, { recursive: true })
  writeFileSync(path.join(tasks, 'keep.json'), '{}')
  writeFileSync(path.join(tasks, 'keep.json.123.abcd.tmp'), '{')
  const res = await app().request('/data/export?kinds=tasks')
  assert.equal(res.status, 200)
  const body: any = await res.json()
  assert.deepEqual(Object.keys(body.files), ['tasks/keep.json'])
  assert.equal(body.skipped, undefined, '没跳过文件时不带 skipped')
})

test('导出时文件读的时候已经没了（任务正好在写、刚删）：跳过并列进 skipped，别的错照样抛', async () => {
  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
  const read = async (full: string) => {
    if (full.endsWith('b.json')) throw gone
    return Buffer.from('{}')
  }
  const r = await readBackupFiles(['tasks/a.json', 'tasks/b.json', 'tasks/c.json.1.x.tmp'], read)
  assert.deepEqual(Object.keys(r.files), ['tasks/a.json'])
  assert.deepEqual(r.skipped, ['tasks/b.json'])
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  await assert.rejects(
    readBackupFiles(['tasks/a.json'], async () => {
      throw denied
    }),
    /denied/,
  )
})

test('导入旧版本的备份：里面带 chats/ 工作目录也照样导入，不写进数据目录', async () => {
  const body = {
    app: 'agent-panel',
    version: 1,
    exportedAt: '2025-01-01T00:00:00.000Z',
    kinds: ['tasks'],
    files: {
      'tasks/tasks.json': Buffer.from('[]').toString('base64'),
      // 改动前的「任务记录」把对话工作目录也打进备份了
      'chats/abc/snapshot.html': Buffer.from('<html></html>').toString('base64'),
    },
  }
  const res = await app().request('/data/import', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(res.status, 200, '旧备份不能因为多带工作目录就整份导不进来')
  const out = (await res.json()) as { kinds: string[]; files: number }
  assert.deepEqual(out.kinds, ['tasks'])
  assert.equal(out.files, 1, '工作目录那份没写进去')
  assert.ok(!existsSync(path.join(dir, 'chats', 'abc')), '工作目录不进数据目录')
})

test('伪造「工作目录」分类的备份不会清掉 chats/', async () => {
  const keep = path.join(dir, 'chats', 'keep')
  mkdirSync(keep, { recursive: true })
  writeFileSync(path.join(keep, 'a.txt'), 'keep')
  const body = {
    app: 'agent-panel',
    version: 1,
    exportedAt: '2025-01-01T00:00:00.000Z',
    kinds: ['workspace'],
    files: {},
  }
  const res = await app().request('/data/import', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(res.status, 200)
  assert.ok(existsSync(path.join(keep, 'a.txt')), '工作目录不能通过导入被整类清掉')
})
