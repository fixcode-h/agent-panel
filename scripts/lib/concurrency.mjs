/**
 * 测试入口的并发数（单测并发批、端到端分片、界面检查分片共用）：CPU、可用内存、单元数三者取小。
 *
 * 以前只按核数算：云端容器核多内存少时，几个分片各起一个服务 + 浏览器就把内存吃满，
 * 表现成随机超时、浏览器崩溃，看上去像用例抖动。现在每个单元按经验占用估一份内存，内存放不下就少开。
 *
 * 环境变量两种用法（见 openspec test-governance 4.1 / 4.3）：
 * - override（单测）：写了就照它开，调试时想全并发或者串行用；
 * - cap（端到端、界面检查）：只是上限之一，不能抬高自动建议，内存不够时写 99 也只开得起那么多。
 * 空、0、负数、非数字都按没写处理。
 */
import { availableParallelism, freemem } from 'node:os'

/** 每个单元大概占多少内存（实测峰值取整）：单测文件一个 tsx 进程，分片一个服务加一组假 CLI / 一个浏览器 */
export const UNIT_MEMORY = {
  unit: 120 * 1024 ** 2,
  e2e: 600 * 1024 ** 2,
  ui: 500 * 1024 ** 2,
}

/** 留给系统和别的进程的余量：只用可用内存的这个比例 */
export const MEMORY_SHARE = 0.7

/**
 * 现在能用的内存（字节）：Node 20.13+ 的 process.availableMemory 会算进 cgroup 限制，
 * 老版本退回 os.freemem（不含可回收的页缓存，偏保守）
 */
export function availableMemoryBytes() {
  try {
    const v = process.availableMemory?.()
    if (Number.isFinite(v) && v > 0) return v
  } catch {
    // 个别平台没实现：按 freemem 算
  }
  return freemem()
}

const positive = (v) => {
  const n = Number(v)
  return v !== '' && v !== null && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
}

/**
 * 算并发数。返回 { value, source, cpu, memory, units, env, note }：
 * value 是要开的数，source 说是哪一项定的（env / cpu / memory / units），note 是写进日志的一句话。
 * cpuFactor：每核开几个（单测文件大半时间在等定时器，可以超开）
 */
export function suggestConcurrency({
  kind,
  units,
  /** 额外的默认上限（e2e 的 4）；0 表示没有 */
  defaultCap = 0,
  env,
  envName,
  mode = 'cap',
  cpuFactor = 1,
  cpus = availableParallelism(),
  memoryBytes = availableMemoryBytes(),
}) {
  const per = UNIT_MEMORY[kind] ?? UNIT_MEMORY.unit
  const cpu = Math.max(1, Math.ceil(cpus * cpuFactor))
  const memory = Math.max(1, Math.floor((memoryBytes * MEMORY_SHARE) / per))
  const count = Math.max(1, defaultCap ? Math.min(units, defaultCap) : units)
  const asked = positive(env)
  const facts = `CPU ${cpus} 核 → ${cpu}，可用内存 ${(memoryBytes / 1024 ** 3).toFixed(1)}G → ${memory}，单元 ${count}`
  if (asked && mode === 'override') {
    const value = Math.min(asked, count)
    return { value, source: 'env', cpu, memory, units: count, env: asked, note: `按 ${envName}=${asked}（${facts}）` }
  }
  const candidates = [['cpu', cpu], ['memory', memory], ['units', count], ...(asked ? [['env', asked]] : [])]
  const [source, value] = candidates.reduce((a, b) => (b[1] < a[1] ? b : a))
  const label = { cpu: ' CPU ', memory: '内存', units: '单元数', env: ` ${envName} ` }[source]
  // 写了环境变量却没用上（比自动建议大）：说清楚它只是上限，免得以为设置没生效是 bug
  const ignored = asked && source !== 'env' && asked > value ? `；${envName}=${asked} 只作上限，没用上` : ''
  return { value, source, cpu, memory, units: count, env: asked, note: `由${label}决定（${facts}${ignored}）` }
}

/** 日志里的一行：「[e2e] 并发 2，由内存决定（CPU 8 核 → 8，可用内存 2.0G → 2，单元 4）」 */
export const concurrencyLine = (tag, c) => `${tag} 并发 ${c.value}，${c.note}`
