import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { MemoryPoint } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'
import { DATA_DIR } from '../store.ts'
import { looksLikePanelCli, trackedClis, type TrackedCli } from './orphans.ts'

/**
 * 对话进程的内存统计：一次系统快照（pid、父 pid、RSS、命令行、启动时刻），按 ppid 拼成进程树，
 * 再把面板登记的 CLI 连同它起的 MCP 服务、shell 一起算进所属对话。
 *
 * 快照是外部命令（Windows 上 CIM 查询要 1~2 秒），所以异步跑、结果缓存几秒：进程面板 5 秒刷新一次、
 * 内存采样 30 秒一次，共用同一份快照，不会一个请求就拉一遍系统进程表。
 * 取不到（权限、命令不存在、被系统限制）时返回 null，界面显示「未知」，不报错。
 */

export type ProcNode = {
  pid: number
  ppid: number
  /** 常驻内存（字节）；系统没给时 null */
  rss: number | null
  argv: string
  /** 进程启动时刻（epoch ms）；系统没给时 null */
  startedAt: number | null
}

const run = promisify(execFile)

/** 快照默认复用时长：进程面板 5 秒刷新，比它短一点，既是新的又不会每次都拉一遍 */
const SNAPSHOT_TTL_MS = 4000

let cache: { at: number; map: Map<number, ProcNode> | null } | null = null
let inflight: Promise<Map<number, ProcNode> | null> | null = null

/** 系统进程表；同一个时刻只有一次查询在跑 */
export function processSnapshot(maxAgeMs = SNAPSHOT_TTL_MS): Promise<Map<number, ProcNode> | null> {
  if (cache && Date.now() - cache.at <= maxAgeMs) return Promise.resolve(cache.map)
  if (inflight) return inflight
  const p = collect()
    .then((map) => {
      cache = { at: Date.now(), map }
      return map
    })
    .finally(() => {
      if (inflight === p) inflight = null
    })
  inflight = p
  return p
}

async function collect(): Promise<Map<number, ProcNode> | null> {
  try {
    return process.platform === 'win32' ? await collectWindows() : await collectPosix()
  } catch (e) {
    log.warn('exec', '取不到系统进程表，进程内存显示为未知', { error: (e as Error).message })
    return null
  }
}

type WinRow = {
  ProcessId?: number
  ParentProcessId?: number
  WorkingSetSize?: number | string
  StartedMs?: number | string | null
  CommandLine?: string | null
}

async function collectWindows(): Promise<Map<number, ProcNode>> {
  // CreationDate 在 ConvertTo-Json 里会变成 "\/Date(...)\/"，这里先换成毫秒数，解析不用猜格式
  const script =
    '$OutputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,' +
    "@{n='StartedMs';e={if ($_.CreationDate) {[int64]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds} else {$null}}}," +
    'CommandLine | ConvertTo-Json -Compress'
  const { stdout } = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 25_000, maxBuffer: 32 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout.trim() || 'null') as WinRow | WinRow[] | null
  const map = new Map<number, ProcNode>()
  for (const p of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) {
    if (typeof p.ProcessId !== 'number') continue
    const rss = Number(p.WorkingSetSize)
    const started = Number(p.StartedMs)
    map.set(p.ProcessId, {
      pid: p.ProcessId,
      ppid: typeof p.ParentProcessId === 'number' ? p.ParentProcessId : 0,
      rss: Number.isFinite(rss) ? rss : null,
      argv: p.CommandLine ?? '',
      startedAt: Number.isFinite(started) && started > 0 ? started : null,
    })
  }
  return map
}

async function collectPosix(): Promise<Map<number, ProcNode>> {
  // etimes 只有 Linux 有；macOS 的 ps 不认，回退到没有启动时刻的版本（子进程的持续时间显示为空）
  const out = await psWith(['-eo', 'pid=,ppid=,rss=,etimes=,args=']).catch(() =>
    psWith(['-eo', 'pid=,ppid=,rss=,args=']),
  )
  const map = new Map<number, ProcNode>()
  const now = Date.now()
  let last: ProcNode | undefined
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)\s+)?(.*)$/)
    if (!m) {
      // 命令行里带换行时 ps 会折成几行：接到上一条上，别把后半截丢掉
      if (last && line.trim()) last.argv += ` ${line.trim()}`
      continue
    }
    const rssKb = Number(m[3])
    const etimes = m[4] === undefined ? NaN : Number(m[4])
    last = {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rss: Number.isFinite(rssKb) ? rssKb * 1024 : null,
      argv: m[5] ?? '',
      startedAt: Number.isFinite(etimes) ? now - etimes * 1000 : null,
    }
    map.set(last.pid, last)
  }
  return map
}

async function psWith(args: string[]) {
  const { stdout } = await run('ps', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/**
 * 一棵进程树（含自己）。Windows 上进程 id 会复用、parent 可能已经退出成环，所以按已访问集合走，
 * 不会因为脏数据转不出来。子进程按 pid 升序返回，界面上的顺序稳定
 */
export function subtree(root: number, map: Map<number, ProcNode>): number[] {
  if (!map.has(root)) return []
  const kids = new Map<number, number[]>()
  for (const p of map.values()) {
    const list = kids.get(p.ppid)
    if (list) list.push(p.pid)
    else kids.set(p.ppid, [p.pid])
  }
  const out: number[] = []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift()!
    out.push(pid)
    for (const k of kids.get(pid) ?? []) {
      if (seen.has(k)) continue
      seen.add(k)
      queue.push(k)
    }
  }
  return out
}

/**
 * root 名下的全部后代（不含 root）。和 subtree 不同，root 自己已经退出、不在进程表里也照样按 ppid 往下找：
 * Windows 上父进程先被结束后，孙进程的 ppid 还指着它，taskkill /T 就找不到它们了，停止时要按快照补杀
 */
export function descendants(root: number, map: Map<number, ProcNode>): number[] {
  const kids = new Map<number, number[]>()
  for (const p of map.values()) {
    if (p.pid === p.ppid) continue
    const list = kids.get(p.ppid)
    if (list) list.push(p.pid)
    else kids.set(p.ppid, [p.pid])
  }
  const out: number[] = []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (seen.has(k)) continue
      seen.add(k)
      out.push(k)
      queue.push(k)
    }
  }
  return out
}

/** 这些 pid 的 RSS 合计；系统没给 RSS 的不计入，一个都没有时返回 null（界面显示「未知」） */
export function sumRss(pids: Iterable<number>, map: Map<number, ProcNode>): number | null {
  let total = 0
  let got = 0
  for (const pid of pids) {
    const rss = map.get(pid)?.rss
    if (rss === null || rss === undefined) continue
    total += rss
    got++
  }
  return got ? total : null
}

/**
 * 按对话（rootTaskId）汇总登记的进程树。父子两棵都登记过时同一个 pid 只算一次，
 * 否则内存合计会比系统里看到的翻倍
 */
export function aggregateByRoot(
  entries: TrackedCli[],
  map: Map<number, ProcNode>,
): Map<string, { rss: number; pids: number }> {
  const out = new Map<string, { rss: number; pids: number }>()
  const seen = new Set<number>()
  for (const e of entries) {
    const root = e.owner?.rootTaskId
    if (!root) continue
    for (const pid of subtree(e.pid, map)) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const cur = out.get(root) ?? { rss: 0, pids: 0 }
      cur.pids++
      const rss = map.get(pid)?.rss
      if (rss !== null && rss !== undefined) cur.rss += rss
      out.set(root, cur)
    }
  }
  return out
}

/**
 * 按执行它的任务（ownerTaskId）汇总登记的进程树。历史采样按这个口径存，
 * 读的时候把「当前任务 + 它的后代」这些 id 的 rss 加起来，子对话才只看到自己这一支。
 * 同一个 pid 只算一次（父子任务都登记过时，和 aggregateByRoot 一样不重复计）
 */
export function aggregateByTask(
  entries: TrackedCli[],
  map: Map<number, ProcNode>,
): Map<string, { rss: number; pids: number }> {
  const out = new Map<string, { rss: number; pids: number }>()
  const seen = new Set<number>()
  for (const e of entries) {
    const taskId = e.owner?.taskId
    if (!taskId) continue
    for (const pid of subtree(e.pid, map)) {
      if (seen.has(pid)) continue
      seen.add(pid)
      const cur = out.get(taskId) ?? { rss: 0, pids: 0 }
      cur.pids++
      const rss = map.get(pid)?.rss
      if (rss !== null && rss !== undefined) cur.rss += rss
      out.set(taskId, cur)
    }
  }
  return out
}

/**
 * 这个对话子树登记的进程：owner.taskId 在 ids 里才算，祖先、兄弟和无归属的面板动作都不算。
 * 进程面板、allowedPids（关闭 / 清理 / AI 建议）共用这一处，别各写一份过滤
 */
export function ownedEntries(entries: TrackedCli[], ids: ReadonlySet<string>): TrackedCli[] {
  return entries.filter((e) => !!e.owner && ids.has(e.owner.taskId))
}

/** 命令行摘要：MCP 配置和面板临时目录的路径很长，界面上看不出信息，替换掉 */
export function commandSummary(argv: string, max = 140) {
  const s = argv
    .replace(/\s+/g, ' ')
    .trim()
    // 面板每轮建的临时目录（放桥接脚本、系统提示词），一串随机 id 没有信息量
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"']*[\\/]cli-run[\\/][^\s"']*/g, '…')
    // MCP 配置是整段 JSON
    .replace(/(--mcp-config[= ])\S+/i, '$1…')
    .replace(/\{"mcpServers":.*/i, '{…}')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 面板登记的进程当前算什么状态：任务还在执行、很久没有输出、任务已经不在跑了 */
export type TrackedStatus = 'running' | 'idle' | 'orphan'

/** 多久没有输出算「无输出」：执行中的 CLI 长时间不出声时，用户可能想关掉它 */
export const IDLE_OUTPUT_MS = 10 * 60_000

export function trackedStatus(
  entry: TrackedCli,
  aliveTask: (taskId: string) => boolean,
  now = Date.now(),
): TrackedStatus {
  const taskId = entry.owner?.taskId ?? ''
  if (!taskId || !aliveTask(taskId)) return 'orphan'
  return now - (entry.lastOutputAt ?? entry.startedAt) > IDLE_OUTPUT_MS ? 'idle' : 'running'
}

/**
 * 「清理」能动的进程：只认面板登记过、任务已经不在跑、命令行里仍带面板痕迹的。
 * 用户自己在终端开的进程不在登记里，永远进不来；命令行的痕迹是第二道保险（pid 可能被复用）
 */
export function cleanableClis(o: {
  entries: TrackedCli[]
  map: Map<number, ProcNode> | null
  aliveTask: (taskId: string) => boolean
  /** 只清这些任务（当前对话 + 它的后代）起的；不传时清所有对话的残留，传空集合一个都不清 */
  taskIds?: ReadonlySet<string> | readonly string[]
  /** 用户确认时勾选的 pid；为空时清全部符合的 */
  only?: number[]
}): { targets: TrackedCli[]; skipped: { pid: number; reason: string }[]; gone: number[] } {
  const targets: TrackedCli[] = []
  const skipped: { pid: number; reason: string }[] = []
  const gone: number[] = []
  const only = o.only?.length ? new Set(o.only) : null
  const ids = o.taskIds ? new Set(o.taskIds) : null
  // 和 processPanel / allowedPids 同一套归属过滤：祖先、兄弟和无归属的面板动作都不在清理范围里
  for (const e of ids ? ownedEntries(o.entries, ids) : o.entries) {
    if (only && !only.has(e.pid)) continue
    // 进程已经不在了：登记是残留，清掉登记就行
    if (o.map && !o.map.has(e.pid)) {
      gone.push(e.pid)
      continue
    }
    // 有快照时以进程当下的命令行为准（pid 可能被别的进程复用了）；没有快照时只能信登记
    const liveArgv = o.map?.get(e.pid)?.argv ?? e.argv
    if (o.map && !looksLikePanelCli(liveArgv)) {
      skipped.push({ pid: e.pid, reason: t('命令行不像面板起的进程（pid 可能已被复用）') })
      continue
    }
    if (e.owner?.taskId && o.aliveTask(e.owner.taskId)) {
      skipped.push({ pid: e.pid, reason: t('任务还在执行') })
      continue
    }
    targets.push(e)
  }
  return { targets, skipped, gone }
}

// ---- 内存历史：30 秒一点，最多 2000 点（约 16 小时），落盘后重启接着用 ----

export const HISTORY_FILE = path.join(DATA_DIR, 'run', 'memory-history.json')
export const SAMPLE_INTERVAL_MS = 30_000
export const HISTORY_CAPACITY = 2000

/** 一个采样点：面板 server 自己的 RSS，以及各对话（rootTaskId / ownerTaskId）CLI 进程树的 RSS 合计 */
export type StoredSample = {
  t: number
  server: number
  roots: { root: string; rss: number; pids: number }[]
  /** 按执行它的任务分开记；新采样才有，读历史时用它算「某个任务 + 后代」的合计 */
  tasks?: { taskId: string; rss: number; pids: number }[]
  /** 这一点的系统进程表没取到：各对话的 CLI 内存是「未知」而不是 0 */
  unavailable: boolean
}

/** 环形缓冲：超了从头丢，数组顺序始终按时间从旧到新 */
export function pushSample(list: StoredSample[], s: StoredSample, capacity = HISTORY_CAPACITY): StoredSample[] {
  const next = [...list, s]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

export function loadHistory(file = HISTORY_FILE): StoredSample[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { samples?: unknown }
    const list = Array.isArray(raw.samples) ? raw.samples : []
    return list.filter(
      (x): x is StoredSample =>
        !!x &&
        typeof x === 'object' &&
        Number.isFinite((x as StoredSample).t) &&
        Number.isFinite((x as StoredSample).server),
    )
  } catch {
    return []
  }
}

export function saveHistory(list: StoredSample[], file = HISTORY_FILE) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ samples: list }))
  } catch (e) {
    log.warn('exec', '内存历史写不进去，这次先只留在内存里', { error: (e as Error).message })
  }
}

/**
 * 某个对话的曲线：只取这个对话及附属（taskIds 里的任务）的 CLI 内存，面板 server 单独给出。
 * total 和 cli 相同：面板自己的内存不属于这个对话，不能混进合计（否则 0 个进程也显示几百 MB）
 */
export function summarize(
  list: StoredSample[],
  /** 任务 id 集合：用 Set 或数组传，不要传单个 string（string 会被当成字符集合） */
  taskIds: ReadonlySet<string> | readonly string[],
  opts: { from?: number; to?: number } = {},
): MemoryPoint[] {
  const ids = new Set(taskIds)
  const out: MemoryPoint[] = []
  for (const s of list) {
    if (opts.from !== undefined && s.t < opts.from) continue
    if (opts.to !== undefined && s.t > opts.to) continue
    const cli = s.unavailable ? null : sampleRss(s, ids)
    out.push({ t: s.t, server: s.server, cli, total: cli })
  }
  return out
}

/**
 * 一个采样点里这些任务的 CLI 内存合计。新采样按任务分开记，子对话只加自己这一支；
 * 旧数据只有根任务聚合：当前是根对话时仍能还原整棵树，子对话拆不出来、返回 null（未知），
 * 不能当成 0 —— 升级前后的点混在一起会把曲线画成 0 起步、趋势误判成持续上涨
 */
function sampleRss(s: StoredSample, ids: Set<string>): number | null {
  if (Array.isArray(s.tasks)) {
    let sum = 0
    for (const x of s.tasks) if (ids.has(x.taskId)) sum += x.rss
    return sum
  }
  const roots = s.roots ?? []
  // 旧样本里一个进程都没有：确实没有，就是 0
  if (!roots.length) return 0
  let sum = 0
  let hit = false
  for (const r of roots) {
    if (!ids.has(r.root)) continue
    sum += r.rss
    hit = true
  }
  return hit ? sum : null
}

/** 采一次：面板 server 自身 + 每个对话的 CLI 进程树。快照取不到时 catalog 记成未知 */
export async function takeSample(entries?: TrackedCli[], map?: Map<number, ProcNode> | null): Promise<StoredSample> {
  const list = entries ?? trackedClis()
  const snapshot = map === undefined ? await processSnapshot() : map
  const byRoot = snapshot ? aggregateByRoot(list, snapshot) : null
  const byTask = snapshot ? aggregateByTask(list, snapshot) : null
  return {
    t: Date.now(),
    server: process.memoryUsage().rss,
    roots: byRoot ? [...byRoot].map(([root, v]) => ({ root, rss: v.rss, pids: v.pids })) : [],
    tasks: byTask ? [...byTask].map(([taskId, v]) => ({ taskId, rss: v.rss, pids: v.pids })) : [],
    unavailable: !snapshot,
  }
}

/**
 * 启动定期采样。每 30 秒一次，落盘按 2 分钟节流（16 小时的历史也就几百 KB，不用每点都写）；
 * 采样本身是异步的外部命令，不占事件循环，不会卡住 CLI 的输出通道
 */
export function startMemorySampler(o: { intervalMs?: number; saveEveryMs?: number } = {}) {
  const intervalMs = o.intervalMs ?? SAMPLE_INTERVAL_MS
  const saveEveryMs = o.saveEveryMs ?? 120_000
  let list = loadHistory()
  let lastSave = 0
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      const sample = await takeSample()
      // 前一点时间太近（重启、手动触发）就不重复记
      const prev = list[list.length - 1]
      if (prev && sample.t - prev.t < Math.min(5000, intervalMs / 2)) return
      list = pushSample(list, sample)
      if (Date.now() - lastSave >= saveEveryMs) {
        lastSave = Date.now()
        saveHistory(list)
      }
    } catch (e) {
      log.warn('exec', '内存采样失败，跳过这一点', { error: (e as Error).message })
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref()
  log.info('exec', '内存采样已启动', { intervalMs, 已有: list.length })
  return () => {
    stopped = true
    clearInterval(timer)
    saveHistory(list)
  }
}

/**
 * AI 清理的提示词：只让它挑「任务已经结束了但进程还留着」的，任务在跑、面板自己的一律不动。
 * 输出约定成 JSON，界面解析不出来时把原文给用户看
 */
export function buildSuggestPrompt(panel: {
  processes: {
    pid: number
    command: string
    ownerTitle: string
    status: string
    durationMs: number | null
    rss: number | null
  }[]
}) {
  const rows = panel.processes.map((p) => ({
    pid: p.pid,
    command: p.command,
    owner: p.ownerTitle,
    status: p.status,
    minutes: p.durationMs === null ? null : Math.round(p.durationMs / 60_000),
    mb: p.rss === null ? null : Math.round(p.rss / 1024 / 1024),
  }))
  return [
    '下面是 Agent 面板启动的 CLI 进程列表（JSON）。用户在问：这里面哪些可以安全关掉。',
    '',
    '规则：',
    '- 只建议 status 为 orphan 的（它所属的任务已经不在执行了，进程是残留）。',
    '- status 是 running 或 idle 的一律不建议，任务可能还在干活。',
    '- 面板 server 自己、用户自己在终端开的进程不在列表里，不要提它们。',
    '- 每条给一个中文理由，30 字以内。',
    '- 只输出一段 JSON，不要解释、不要代码块外的文字：{"kill":[{"pid":123,"reason":"..."}]}',
    '- 没有可以关的就输出 {"kill":[]}。',
    '',
    JSON.stringify(rows, null, 2),
  ].join('\n')
}
