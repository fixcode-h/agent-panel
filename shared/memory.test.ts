import assert from 'node:assert/strict'
import test from 'node:test'
import type { MemorySample } from './data.ts'
import { setLang } from './i18n.ts'
import { FixInput, fixPrompt } from './fix.ts'
import {
  chartWindow,
  formatBytes,
  formatSampleTime,
  formatUptime,
  memoryReport,
  memoryTrend,
  panEndMs,
} from './memory.ts'

// formatUptime 出来的单位是界面文案：固定中文，不跟着本机语言走
setLang('zh')

const MB = 1024 * 1024
const T0 = Date.parse('2025-01-01T10:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const sample = (minutes: number, rss: number, extra: Partial<MemorySample> = {}): MemorySample => ({
  at: at(minutes),
  rss,
  heapTotal: 256 * MB,
  heapUsed: rss / 2,
  external: 4 * MB,
  arrayBuffers: 2 * MB,
  running: 0,
  child: null,
  ...extra,
})

test('大小和运行时长按人看得懂的方式显示', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1.5 * MB), '1.5 MB')
  assert.equal(formatBytes(2 * 1024 * MB), '2.00 GB')
  assert.equal(formatUptime(20_000), '20 秒')
  assert.equal(formatUptime(5 * 60_000), '5 分钟')
  assert.equal(formatUptime(3 * 3600_000 + 12 * 60_000), '3 小时 12 分')
  assert.equal(formatUptime(51 * 3600_000), '2 天 3 小时')
})

test('采样时刻显示本地时间，跨天带上月-日', () => {
  const now = new Date(2025, 0, 2, 12, 0, 0)
  assert.equal(formatSampleTime(new Date(2025, 0, 2, 10, 5, 0).toISOString(), now), '10:05')
  assert.equal(formatSampleTime(new Date(2025, 0, 1, 23, 40, 0).toISOString(), now), '1-1 23:40')
  assert.equal(formatSampleTime('不是时间', now), '')
})

test('趋势：持续上涨判成 up，平稳和回落分开', () => {
  const up = [0, 3, 6, 9, 12].map((m) => sample(m, (100 + m * 5) * MB))
  const tr = memoryTrend(up)!
  assert.equal(tr.trend, 'up')
  assert.ok(tr.delta > 20 * MB)
  assert.ok(tr.perMinute > 0)
  assert.equal(tr.peak.rss, 160 * MB)

  const flat = [0, 3, 6, 9, 12].map((m) => sample(m, (100 + (m % 2)) * MB))
  assert.equal(memoryTrend(flat)!.trend, 'flat')

  const down = [0, 3, 6, 9, 12].map((m) => sample(m, (200 - m * 8) * MB))
  assert.equal(memoryTrend(down)!.trend, 'down')
})

test('趋势：点不够、跨度太短时不乱下结论', () => {
  assert.equal(memoryTrend([]), null)
  assert.equal(memoryTrend([sample(0, 100 * MB)]), null)
  // 只有 2 分钟，刚开始跑的增长不算泄漏
  const short = [sample(0, 100 * MB), sample(2, 180 * MB)]
  assert.equal(memoryTrend(short)!.trend, 'flat')
})

test('曲线窗口：只取窗口里的点，窗口前一个点也带上（线画到边上）', () => {
  const samples = [0, 10, 20, 30, 40, 50, 60, 70].map((m) => sample(m, 100 * MB))
  const win = chartWindow(samples, T0 + 60 * 60_000, 60 * 60_000)
  assert.equal(win.from, T0)
  assert.equal(win.to, T0 + 60 * 60_000)
  assert.deepEqual(
    win.points.map((p) => p.at),
    [at(0), at(10), at(20), at(30), at(40), at(50), at(60)],
  )
  // 窗口右端往前挪 30 分钟：前面那个（0 分钟）也被带进来，线不会从窗口中间凭空开始
  const older = chartWindow(samples, T0 + 30 * 60_000, 60 * 60_000)
  assert.deepEqual(
    older.points.map((p) => p.at),
    [at(0), at(10), at(20), at(30)],
  )
})

test('右键拖动：往右拖看更早，限制在最早采样和最新之间', () => {
  const base = { widthPx: 600, windowMs: 60 * 60_000, earliestMs: T0, latestMs: T0 + 120 * 60_000 }
  // 往右拖半张图 = 往回看 30 分钟
  assert.equal(panEndMs({ ...base, endMs: T0 + 120 * 60_000, dxPx: 300 }), T0 + 90 * 60_000)
  // 往左拖 = 回到更近的区间，超过最新就停在最新
  assert.equal(panEndMs({ ...base, endMs: T0 + 60 * 60_000, dxPx: -800 }), T0 + 120 * 60_000)
  // 一直往右拖：最早只能停在「最早采样 + 一个窗口」
  assert.equal(panEndMs({ ...base, endMs: T0 + 120 * 60_000, dxPx: 5000 }), T0 + 60 * 60_000)
  // 量不到宽度时不动
  assert.equal(panEndMs({ ...base, endMs: T0 + 90 * 60_000, dxPx: 100, widthPx: 0 }), T0 + 90 * 60_000)
})

test('交给 AI 的报告：两路内存、趋势、规模、数据目录都在，未采集不写成 0', () => {
  const samples = [0, 3, 6, 9, 12].map((m) => sample(m, (100 + m * 4) * MB, { child: (300 + m * 10) * MB }))
  const report = memoryReport({
    memory: samples[samples.length - 1],
    samples,
    sampling: { intervalMs: 30_000, keepMs: 2 * 3600_000 },
    uptimeMs: 3 * 3600_000,
    child: { processes: 3, bytes: samples[samples.length - 1].child },
    scale: { tasks: 42, chats: 18, projects: 5, running: 1 },
    dir: '/data',
    kinds: [
      { id: 'tasks', files: 42, bytes: 640 * MB },
      { id: 'config', files: 12, bytes: 1 * MB },
    ],
    logs: { dir: '/data/logs', current: '', files: 30, bytes: 48 * MB },
  })
  assert.ok(report.includes('面板服务进程'))
  assert.ok(report.includes('子进程'), '子进程那一路单独写')
  assert.ok(report.includes('两路合计'), '两路有合计')
  assert.ok(report.includes('RSS 趋势'), '有趋势')
  assert.ok(report.includes('面板规模：任务 42 个（其中对话 18 个）'))
  assert.ok(report.includes('数据目录（/data）：共'))
  assert.ok(report.includes('运行日志：30 个文件'))

  // 读不到子进程内存时说「未采集」，不能出现「合计 0」
  const blind = memoryReport({
    memory: sample(0, 120 * MB),
    samples: [sample(0, 120 * MB)],
    sampling: { intervalMs: 30_000, keepMs: 2 * 3600_000 },
    uptimeMs: 60_000,
    child: { processes: 2, bytes: null },
    scale: { tasks: 1, chats: 0, projects: 0, running: 1 },
  })
  assert.ok(blind.includes('未采集'))
  assert.ok(blind.includes('不是 0'))
  assert.ok(!blind.includes('合计 0'))
})

test('不是报错时的提示词：换成主动检查，不写成「出错了」', () => {
  const input = FixInput.parse({ title: '面板内存分析', ask: '看一下内存有没有问题', topic: 'memory' })
  const prompt = fixPrompt(input, { os: 'win32', cwd: '/tmp/x' })
  assert.ok(prompt.includes('要做一次主动检查'))
  assert.ok(prompt.includes('这次要做的：看一下内存有没有问题'))
  assert.ok(!prompt.includes('在操作时出错了'))
  assert.ok(!prompt.includes('出了什么问题'))
  assert.ok(prompt.includes('先给结论和方案，不要直接改代码'))
})

test('普通的报错提示词不受影响', () => {
  const prompt = fixPrompt(FixInput.parse({ title: '卸载 Pi 没有成功', error: 'EACCES' }), {
    os: 'win32',
    cwd: '/tmp/x',
  })
  assert.ok(prompt.includes('在操作时出错了'))
  assert.ok(prompt.includes('出了什么问题：卸载 Pi 没有成功'))
  assert.ok(prompt.includes('只做解决这个问题需要的改动'))
})
