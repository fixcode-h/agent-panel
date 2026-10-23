/**
 * 面板内存采样：每隔一段时间记一次面板进程和它拉起的子进程各占多少内存。
 * 只放在内存里（数组），不写数据目录：重启后面板的内存本来就是新的，旧的曲线没有参考价值。
 * 设置 →「数据」的内存曲线和「AI 分析」都读这里，保证界面上的数字和交给 AI 的是同一份采样。
 */
import { readFile } from 'node:fs/promises'
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os'
import { getHeapStatistics } from 'node:v8'
import type { MemorySample, MemoryUsage } from '../shared/data.ts'
import { MEMORY_TOPIC, formatBytes, memoryBrief } from '../shared/memory.ts'
import { activePids, capture } from './exec/process.ts'
import { registerFixTopic } from './fix.ts'
import { getSettings } from './settings.ts'
import { log } from './log.ts'

/** 序列保留两小时：至少能看到最近一小时的变化，看趋势时还能往前比一段 */
const KEEP_MS = 2 * 60 * 60_000
/** 点数上限：间隔调到 10 秒时也不让数组无限长 */
const MAX_POINTS = 720
const DEFAULT_SECONDS = 30

/** 采样间隔在设置里改；读不到设置或值不合理时按 30 秒 */
async function sampleIntervalMs() {
  const s = await getSettings().catch(() => null)
  const sec = Math.min(3600, Math.max(10, s?.memorySampleSeconds ?? DEFAULT_SECONDS))
  return sec * 1000
}

/** Windows 上查过一次、确认拿不到之后就不再试：不用每 30 秒都起一个 PowerShell */
let winChildMemoryUnsupported = false

/**
 * 子进程（面板拉起的 CLI、检测命令等）合计占用的内存。
 * - Linux：直接读 /proc/<pid>/status 里的 VmRSS，不启动任何进程；
 * - macOS：ps -o rss= 一次查所有 pid；
 * - Windows：Node 没有查别的进程内存的 API，wmic 在新系统上已经移除，只能用 PowerShell 取 WorkingSet64。
 *   这一步要起一个 PowerShell（几百毫秒），所以失败一次就记住「这台机器上拿不到」，之后显示「未采集」，
 *   不每 30 秒重试；读不到时返回 null，绝不能写成 0（0 会被当成真的没占用）。
 * 只算这些 pid 自己，不算 CLI 再起的孙进程。
 */
export async function childMemory(pids: number[]): Promise<number | null> {
  if (!pids.length) return 0
  if (process.platform === 'linux') {
    let total = 0
    let read = 0
    for (const pid of pids) {
      const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '')
      const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
      if (!m) continue
      total += Number(m[1]) * 1024
      read++
    }
    return read ? total : null
  }
  if (process.platform === 'darwin') {
    const r = await capture('ps', ['-o', 'rss=', '-p', pids.join(',')], homedir(), process.env, 4000).catch(() => null)
    const sizes = (r?.stdout ?? '')
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    return sizes.length ? sizes.reduce((a, b) => a + b, 0) * 1024 : null
  }
  if (process.platform === 'win32') {
    if (winChildMemoryUnsupported) return null
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$p=Get-Process -Id ${pids.join(',')}`,
      'if ($p) { [int64](($p | Measure-Object -Property WorkingSet64 -Sum).Sum) } else { 0 }',
    ].join('; ')
    const r = await capture(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      homedir(),
      process.env,
      5000,
    ).catch(() => null)
    const n = Number((r?.stdout ?? '').trim())
    if (!r || r.code !== 0 || !Number.isFinite(n)) {
      winChildMemoryUnsupported = true
      log.warn('memory', '子进程内存读取不到，之后按「未采集」显示', { error: r?.stderr?.slice(-300) })
      return null
    }
    return n
  }
  return null
}

export interface MemorySampler {
  start: () => void
  stop: () => void
  /** 采一次交给接口：第一次打开页面时序列还是空的，现采一个，不返回空 */
  sample: () => Promise<MemorySample>
  snapshot: () => Promise<MemoryUsage>
}

export function memorySampler(
  deps: {
    running: () => number
    scale: () => Promise<{ tasks: number; chats: number; projects: number }>
  },
  /** intervalMs 只在测试里换：正常用法是读设置里的采样间隔 */
  opts: { intervalMs?: () => Promise<number> } = {},
): MemorySampler {
  const interval = opts.intervalMs ?? sampleIntervalMs
  const samples: MemorySample[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = true
  let sampling = false

  async function sample(): Promise<MemorySample> {
    const m = process.memoryUsage()
    const pids = activePids()
    const s: MemorySample = {
      at: new Date().toISOString(),
      rss: m.rss,
      heapTotal: m.heapTotal,
      heapUsed: m.heapUsed,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      running: deps.running(),
      // 拿不到子进程内存时是 null（界面显示「未采集」），不是 0
      child: await childMemory(pids),
    }
    samples.push(s)
    const from = Date.now() - KEEP_MS
    while (samples.length > MAX_POINTS || (samples.length > 1 && Date.parse(samples[0].at) < from)) samples.shift()
    return s
  }

  async function tick() {
    if (stopped || sampling) return
    sampling = true
    try {
      await sample()
    } catch (e) {
      // 采样失败不能影响面板本身，也不静默：写进运行日志
      log.warn('memory', '内存采样失败', { error: (e as Error).message })
    } finally {
      sampling = false
    }
    // 用 setTimeout 而不是 setInterval：间隔在设置里改了，下一次采样就用新的值
    if (!stopped) {
      timer = setTimeout(tick, await interval())
      timer.unref()
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      void interval().then((ms) => log.info('memory', `开始内存采样，每 ${ms / 1000} 秒一次`))
      void tick()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    sample,
    async snapshot() {
      if (!samples.length) await sample()
      const latest = samples[samples.length - 1]
      const scale = await deps.scale().catch(() => ({ tasks: 0, chats: 0, projects: 0 }))
      return {
        memory: latest,
        samples: samples.map((s) => ({ ...s })),
        sampling: { intervalMs: await sampleIntervalMs(), keepMs: KEEP_MS },
        uptimeMs: Math.round(process.uptime() * 1000),
        child: { processes: activePids().length, bytes: latest.child },
        scale: { ...scale, running: latest.running },
      }
    },
  }
}

/**
 * 「AI 分析」的内存体检：服务端补上这台机器的运行环境（Node 版本、V8 堆上限、CPU / 内存），
 * 体检要做什么、按什么顺序回答在 shared/memory.ts 的 memoryBrief 里（演示版也用它）。
 */
registerFixTopic(MEMORY_TOPIC, {
  context: () => {
    const heap = getHeapStatistics()
    return [
      memoryBrief(),
      '',
      `运行环境：Node ${process.version}（V8 堆上限 ${formatBytes(heap.heap_size_limit)}），${platform()} ${release()} ${arch()}，${cpus().length} 核，物理内存 ${formatBytes(totalmem())}。`,
      '上面的采样是面板自己记的：面板进程的 RSS / 堆 / external / ArrayBuffer，以及面板拉起的 CLI 子进程合计内存，每 30 秒（设置里可改）一次、保留最近两小时。',
    ].join('\n')
  },
})
