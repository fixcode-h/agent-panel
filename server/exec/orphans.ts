import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { log } from '../log.ts'
import { DATA_DIR } from '../store.ts'

/**
 * 面板自己起的 CLI 进程登记。正常结束会从文件里删掉；面板被强杀（taskkill /F、崩溃）时来不及，
 * 那些 CLI 连同它们起的 MCP 服务会留在后台，文件也留着 —— 下次启动按它清理。
 *
 * 只登记、只清理命令行里认得出是面板起的进程：带面板的桥接参数（MCP 地址、panel 名字）或面板自己的
 * 临时目录（cache/cli-run/）。用户自己在终端跑的 pi、codex 命令行没有这些，不会被碰。
 *
 * **每个面板实例一份文件**（`run/cli-pids/<面板 pid>.json`）：一个实例只写自己这份，
 * 退出时只删自己这份。以前所有实例共用一份文件、退出时清空整份，一个测试面板退出就把正常在用的面板的
 * 登记全清了；那份文件也是读-改-写，两个实例同时登记会互相覆盖，丢掉的条目在面板被强杀后再也没有线索回收
 * （用户报的现象：CLI 进程活几个小时）。分文件后没有共享写入，这两个问题都不存在。
 * 旧版本的单文件 `run/cli-pids.json` 启动时当遗留读一次、处理完删掉。
 */
const DIR = path.join(DATA_DIR, 'run', 'cli-pids')
const LEGACY_FILE = path.join(DATA_DIR, 'run', 'cli-pids.json')
const SUFFIX = '.json'

/** 当前这个面板进程：自己的登记文件名就是它 */
const PANEL_PID = process.pid
const ownFile = () => path.join(DIR, `${PANEL_PID}${SUFFIX}`)

/** 这条 CLI 是哪个对话（含子对话、子任务、工作流）起的：taskId 是执行它的那个任务，rootTaskId 是对话树的最上层 */
export type TrackedOwner = { taskId: string; rootTaskId: string; title: string }

/** 一条登记：pid、命令行（拼好的，日志和判定用）、工作目录、开始时间 */
export type TrackedCli = {
  pid: number
  argv: string
  cwd: string
  startedAt: number
  /** 起它的面板进程（分文件后和文件名一致）；旧版本的登记没有这一项，当作「不知道哪个实例」照旧清理 */
  panelPid?: number
  /** 归属：任务执行起的进程才有；AI 创建、文档、模型检测这类面板自己的动作为空 */
  owner?: TrackedOwner
  /** 最后一次有输出的时刻（只留在内存里，不写盘）：判断「很久没有输出」 */
  lastOutputAt?: number
}

const run = promisify(execFile)

/**
 * 这条命令行是不是面板起的：面板临时目录（cache/cli-run/<id>）、或者 MCP 参数里 panel 桥接的
 * 本机回环地址。两样都是面板特有的，用户手动跑的命令行里不会有
 */
export function looksLikePanelCli(argv: string) {
  if (!argv) return false
  // Pi 的桥接扩展、写进临时目录的配置文件都在 cache/cli-run/<id> 下
  if (/[\\/]cli-run[\\/]/.test(argv)) return true
  // 参数里直接带 MCP 配置的 CLI：{"mcpServers":{"panel":{"url":"http://127.0.0.1:<端口>/..."}}}
  return /panel/i.test(argv) && /127\.0\.0\.1:\d{2,5}/.test(argv)
}

/**
 * 这个 pid 是不是一个还在跑的面板服务（`node server.mjs`、`node --import tsx server/index.ts`）。
 * 判断「另一个面板实例还活着」不能只看 pid 在不在：旧登记里的 panelPid 可能已经被无关进程复用，
 * 那样那份遗留 CLI 就永远不被清理。CLI 自己（带 cli-run / panel MCP 参数）不算面板。
 *
 * 边界只排除「相邻的字母 / 数字 / 点 / 横线」，不要求前面必须是空白：
 * 包目录里的 `./server.mjs`、带空格的绝对路径写成 `"C:\Program Files\agent-panel\server.mjs"` 都要认。
 * 方向偏「多认」：漏认会把另一个活实例正在跑的 CLI 当遗留杀掉（用户看到对话被打断），
 * 多认只是那条遗留少收一次（兜底回收下一轮还会看到它）
 */
export function looksLikePanelServer(argv: string) {
  if (!argv) return false
  if (looksLikePanelCli(argv)) return false
  return (
    /(?:^|[\\/\s"'])server\.(?:mjs|ts)(?=["'\s]|$)/i.test(argv) ||
    /(?:^|[\\/\s"'])server[\\/]index\.(?:ts|js)(?=["'\s]|$)/i.test(argv)
  )
}

/** 读一份登记文件；坏了当作没有，不会因为一个坏文件起不来 */
function readFileOf(file: string): TrackedCli[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { processes?: unknown }
    const list = Array.isArray(raw.processes) ? raw.processes : []
    return list.filter(
      (x): x is TrackedCli =>
        !!x && typeof x === 'object' && Number.isInteger((x as TrackedCli).pid) && (x as TrackedCli).pid > 0,
    )
  } catch {
    return []
  }
}

/** 写一份登记文件；空了就删掉（列表为空时不留空文件） */
function writeFileOf(file: string, list: TrackedCli[]) {
  try {
    if (!list.length) {
      rmSync(file, { force: true })
      return
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ processes: list }))
  } catch (e) {
    // 写不进去只是少了一次清理机会，不影响执行
    log.warn('exec', 'CLI 进程登记文件写不进去', { file: path.basename(file), error: (e as Error).message })
  }
}

/** 各实例的登记文件（不含旧版单文件） */
function trackedFiles(): string[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(SUFFIX))
      .map((f) => path.join(DIR, f))
  } catch {
    return []
  }
}

/** 所有要读/清理的登记文件：旧版单文件排在最前，处理完就删 */
function allFiles(): string[] {
  return [...trackedFiles(), LEGACY_FILE]
}

/** 文件名里的面板 pid；旧版单文件是 0（不知道哪个实例） */
function panelPidOfFile(file: string) {
  const base = path.basename(file)
  if (base === path.basename(LEGACY_FILE)) return 0
  const n = Number(base.slice(0, -SUFFIX.length))
  return Number.isInteger(n) && n > 0 ? n : 0
}

const isOurs = (x: TrackedCli) => x.panelPid === PANEL_PID

/**
 * 登记在内存里留一份（只留本实例的），文件只在有变化时写。以前每个进程结束（包括 git status 这类短命令）
 * 都要同步读一遍文件，子对话一多、git 查询一频繁，事件循环上就全是同步读盘。
 * 别的实例那份也缓一次（foreign）：进程面板要列本机所有面板的 CLI，但不必每次刷新都同步读盘
 */
let mem: TrackedCli[] | null = null
let foreign: TrackedCli[] = []

/** 重新读别的实例那份（不含自己） */
function refreshForeign() {
  const out: TrackedCli[] = []
  for (const file of allFiles()) {
    if (file === ownFile()) continue
    out.push(...readFileOf(file))
  }
  foreign = out
}

const tracked = () =>
  (mem ??= (() => {
    refreshForeign()
    return readonly(readFileOf(ownFile()))
  })())

/** 只算本实例的条目：旧版单文件里也可能有自己的（兼容读） */
const readonly = (list: TrackedCli[]) => list.filter(isOurs)

/** 写自己的文件；别的实例的文件一概不碰 */
function commit(own: TrackedCli[]) {
  mem = own
  writeFileOf(ownFile(), own)
  refreshForeign()
}

/** 面板起了一个带自己痕迹的 CLI：记下来，面板被强杀后下次启动能认出来 */
export function trackCliProcess(pid: number, argv: string, cwd: string, owner?: TrackedOwner) {
  const now = Date.now()
  const list = tracked().filter((x) => x.pid !== pid)
  list.push({ pid, argv, cwd, startedAt: now, lastOutputAt: now, panelPid: PANEL_PID, ...(owner ? { owner } : {}) })
  commit(list)
}

/** 这个进程还有输出（stdout 每一行、stderr 每一块都会走到）：只更新内存，不写盘 */
export function touchCliProcess(pid: number) {
  const e = tracked().find((x) => x.pid === pid)
  if (e) e.lastOutputAt = Date.now()
}

/** 当前登记的进程（副本，含别的面板实例的）；内存采样的每一点都读它，不能把内部数组交出去 */
export function trackedClis(): TrackedCli[] {
  return [...foreign, ...tracked()].map((x) => ({ ...x }))
}

/** 这条登记现在还在不在 */
export function isTrackedCli(pid: number) {
  return tracked().some((x) => x.pid === pid)
}

/** 本实例的进程正常结束了：从登记里去掉（不在登记里时不碰文件，短命令很多） */
export function untrackCliProcess(pid: number) {
  const list = tracked()
  if (!list.some((x) => x.pid === pid)) return
  commit(list.filter((x) => x.pid !== pid))
}

/**
 * 从登记里拿掉一条：自己的文件直接改（只有自己在写）。
 * 别的实例的文件只在「那个面板已经不在了」时才改（这时没有并发写者）；还活着的实例的登记由它自己清，
 * 否则本实例的读-改-写会和它的 trackCliProcess 撞在一起，把它刚登记的进程覆盖掉（就是「每实例一份文件」想根除的问题）
 */
function forgetAny(pid: number, procs: Map<number, string>) {
  const own = tracked().filter((x) => x.pid !== pid)
  if (own.length !== (mem?.length ?? 0)) {
    mem = own
    writeFileOf(ownFile(), own)
  }
  for (const file of trackedFiles()) {
    if (file === ownFile()) continue
    if (panelAlive(procs, panelPidOfFile(file))) continue
    const list = readFileOf(file)
    if (!list.some((x) => x.pid === pid)) continue
    writeFileOf(
      file,
      list.filter((x) => x.pid !== pid),
    )
  }
  foreign = foreign.filter((x) => x.pid !== pid)
}

/** 面板正常退出：本实例起的 CLI 已经由 killAllProcesses 停掉，只删自己这份登记 */
export function clearTrackedClis() {
  commit([])
}

/** 当前所有进程的 pid → 命令行；拿不到时返回空（宁可这次不清理，也不误杀） */
async function listProcesses(): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  try {
    if (process.platform === 'win32') {
      const script =
        '$OutputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
      const { stdout } = await run(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
      )
      const parsed = JSON.parse(stdout.trim() || 'null') as
        | { ProcessId?: number; CommandLine?: string | null }
        | { ProcessId?: number; CommandLine?: string | null }[]
        | null
      for (const p of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) {
        if (typeof p.ProcessId === 'number') out.set(p.ProcessId, p.CommandLine ?? '')
      }
      return out
    }
    const { stdout } = await run('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10_000 })
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/)
      if (m) out.set(Number(m[1]), m[2])
    }
  } catch (e) {
    log.warn('exec', '列不出进程，这次不清理遗留 CLI', { error: (e as Error).message })
  }
  return out
}

/** 那个面板实例现在还活着（进程在，而且命令行像面板服务） */
function panelAlive(all: Map<number, string>, pid: number) {
  return pid > 0 && looksLikePanelServer(all.get(pid) ?? '')
}

/** 杀完之后等一小会儿再确认：进程还在就把登记留着，下一轮兜底回收还能看到它。killTree 3 秒后补杀，这里对齐 */
const KILL_SETTLE_MS = 3500
/** 等的时候多久看一次：都退了就不必把 3.5 秒等满（大多数进程收到信号立刻就退） */
const KILL_POLL_MS = 100
/** 等这些进程退出，最多等 KILL_SETTLE_MS；以前固定等满，每次清理、每条相关用例都白等 3.5 秒 */
async function waitKillSettled(pids: number[]) {
  const until = Date.now() + KILL_SETTLE_MS
  while (Date.now() < until && pids.some(stillAlive)) await new Promise((r) => setTimeout(r, KILL_POLL_MS))
}

/** 进程还在不在；ESRCH 才是真的没了，权限不足（EPERM）说明它还在，不能当已退出去清登记 */
function stillAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 启动时清理上次强杀留下的 CLI：只处理登记过、现在还在、且命令行仍带面板痕迹的进程。
 * 已经结束的、或者 pid 被别的进程复用（命令行不像面板起的）都不动，只写日志。
 * 另一个活着的面板实例的那份登记不碰：它的 CLI 由它自己负责，新实例启动不能把旧实例正在用的杀了。
 * kill 由调用方传入（process.ts 的 killTree），避免这里和进程管理互相 import
 */
export async function cleanStaleCliProcesses(kill: (pid: number) => void): Promise<void> {
  // 本实例的登记文件在自己这个进程里只能是空的（刚启动、还没起过 CLI）；下面清的是别的/遗留实例那份
  mem = []
  const files = allFiles()
  const all = await listProcesses()
  /** 发出停止的条目数（不等于真的退了） */
  let stopped = 0
  let confirmed = 0
  let keptBack = 0
  let keptFiles = 0
  let kept = 0
  /** 发出停止的条目：确认退了才丢登记 */
  const toCheck: { file: string; entry: TrackedCli }[] = []
  /** 每个处理过的文件最终要写回的条目（杀不掉的） */
  const survivorFiles = new Map<string, TrackedCli[]>()
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    const owner = panelPidOfFile(file)
    const entries = readFileOf(file)
    // 另一个面板实例还活着：整份留着，它自己的进程和登记都由它收（不写它那份，避免和它的登记撞车）
    if (owner !== PANEL_PID && panelAlive(all, owner)) {
      keptFiles++
      kept += entries.length
      continue
    }
    const survivors: TrackedCli[] = []
    for (const e of entries) {
      const argv = all.get(e.pid)
      // 已经结束了（或 pid 被复用、命令行不像面板起的）：条目直接丢弃，只记日志
      if (argv === undefined) continue
      if (!looksLikePanelCli(argv)) {
        log.warn('exec', '登记的 pid 现在跑的进程不像面板起的，跳过（pid 可能被复用）', {
          pid: e.pid,
          argv: argv.slice(0, 300),
        })
        continue
      }
      kill(e.pid)
      stopped++
      toCheck.push({ file, entry: e })
      log.warn('exec', '清理上次留下的 CLI 进程', { pid: e.pid, argv: argv.slice(0, 300), cwd: e.cwd })
    }
    writeFileOf(file, survivors)
    survivorFiles.set(file, survivors)
  }
  // kill 是让它自己慢慢退的（POSIX 3 秒后才补杀）：杀不掉的条目要写回去，
  // 否则这一轮就成了永久僵尸——登记没了，下次启动再也找不到它
  if (toCheck.length) {
    await waitKillSettled(toCheck.map((x) => x.entry.pid))
    for (const { file, entry } of toCheck) {
      if (!stillAlive(entry.pid)) {
        confirmed++
        continue
      }
      const list = survivorFiles.get(file) ?? []
      list.push(entry)
      survivorFiles.set(file, list)
      keptBack++
      log.warn('exec', '遗留进程没结束，登记留着下次再试', {
        pid: entry.pid,
        file: path.basename(file),
        存活分钟: Math.round(Math.max(0, Date.now() - entry.startedAt) / 60_000),
      })
    }
  }
  for (const [file, list] of survivorFiles) writeFileOf(file, list)
  refreshForeign()
  log.info('exec', '启动清理遗留 CLI 完成', {
    文件: files.length,
    发出停止: stopped,
    确认退出: confirmed,
    写回待下次: keptBack,
    留给其它面板: keptFiles,
    保留登记: kept,
  })
}

/** 全部登记（含别的面板实例的）：收尾核对和兜底回收要看全量，不能只信本实例那份缓存 */
export function allTrackedClis(): TrackedCli[] {
  const own = tracked()
  const out: TrackedCli[] = []
  for (const file of allFiles()) {
    if (file === ownFile()) continue
    out.push(...readFileOf(file))
  }
  return [...out, ...own]
}

/**
 * 杀一批登记里的进程：先核对 pid 现在跑的还是面板起的（防 pid 复用），
 * 别的活着的面板实例正在用的条目跳过（它的任务状态可能比盘上新，不能从这边判它收口了），
 * 杀完确认真的退了才从登记里去掉；没退的留着，下一轮兜底还能再试
 */
async function killTracked(
  entries: TrackedCli[],
  kill: (pid: number) => void,
  procs?: Map<number, string>,
): Promise<number[]> {
  if (!entries.length) return []
  const all = procs ?? (await listProcesses())
  const targets: TrackedCli[] = []
  for (const e of entries) {
    const argv = all.get(e.pid)
    // 进程已经不在了：登记也清掉，别一直挂着一个不存在的 pid
    if (argv === undefined) {
      forgetAny(e.pid, all)
      continue
    }
    if (!looksLikePanelCli(argv)) {
      log.warn('exec', '登记的 pid 现在跑的进程不像面板起的，跳过（pid 可能被复用）', {
        pid: e.pid,
        argv: argv.slice(0, 300),
      })
      continue
    }
    // 别的面板实例还在跑：这条登记是它在用的进程，由它自己收（和启动清理同口径）
    if (e.panelPid && e.panelPid !== PANEL_PID && panelAlive(all, e.panelPid)) continue
    targets.push(e)
  }
  for (const e of targets) kill(e.pid)
  if (!targets.length) return []
  await waitKillSettled(targets.map((e) => e.pid))
  const killed: number[] = []
  for (const e of targets) {
    if (stillAlive(e.pid)) {
      log.warn('exec', '回收后进程还在，登记留着下一轮再试', { pid: e.pid, task: e.owner?.taskId ?? '' })
      continue
    }
    forgetAny(e.pid, all)
    killed.push(e.pid)
  }
  return killed
}

/**
 * 结束某个任务名下的全部 CLI（含别的面板实例登记的、重启前留下的）。
 * 收尾落 resolved 之后调：正常路径下进程在自己的 live 里已经停了、登记也清过，
 * 这一道兜的是「某条路径漏停」和「重启后没人记得的残留」
 */
export async function killTaskClis(taskId: string, kill: (pid: number) => void): Promise<number[]> {
  if (!taskId) return []
  const entries = allTrackedClis().filter((e) => e.owner?.taskId === taskId)
  const killed = await killTracked(entries, kill)
  if (killed.length) log.info('exec', '收尾后停掉了这个任务留下的 CLI 进程', { task: taskId, 进程: killed })
  return killed
}

/** 一条被兜底回收的进程：日志和测试要看「哪个任务、活了多久」 */
export type ReapedCli = { pid: number; taskId: string; title: string; aliveMs: number }

/**
 * 兜底回收：任务已经收口（`settled` 由调用方按 shared/task.ts 的 taskSettled 判），它登记的 CLI 却还活着。
 * 进程和任务状态存在两份数据里，任何一条停止路径漏掉都会让进程活几个小时（用户报的现象），所以要有这一道：
 * 启动后跑一次，之后每小时一次（见 server/index.ts 的 runCleanup）。
 *
 * 别的活着的面板实例那份不碰（见 killTracked）：它内存里的任务状态比盘上新，这里的「已收口」可能是上一轮。
 * graceMs 给收尾留一个缓冲：停止是异步的（先 SIGTERM，3 秒后才补杀），别把正在退出的算成僵尸
 */
export async function reapSettledTaskClis(o: {
  settled: (taskId: string) => Promise<boolean>
  kill: (pid: number) => void
  graceMs?: number
}): Promise<ReapedCli[]> {
  const candidates = allTrackedClis().filter((e) => !!e.owner?.taskId)
  if (!candidates.length) return []
  const procs = await listProcesses()
  const now = Date.now()
  const grace = o.graceMs ?? 0
  const finished: TrackedCli[] = []
  const picked: ReapedCli[] = []
  for (const e of candidates) {
    const argv = procs.get(e.pid)
    if (argv === undefined) {
      forgetAny(e.pid, procs)
      continue
    }
    if (!looksLikePanelCli(argv)) continue
    const aliveMs = Math.max(0, now - e.startedAt)
    if (aliveMs < grace) continue
    let settled = false
    try {
      settled = await o.settled(e.owner!.taskId)
    } catch {
      settled = false
    }
    if (!settled) continue
    finished.push(e)
    picked.push({ pid: e.pid, taskId: e.owner!.taskId, title: e.owner!.title, aliveMs })
  }
  const killed = await killTracked(finished, o.kill, procs)
  const reaped = picked.filter((x) => killed.includes(x.pid))
  for (const r of reaped) {
    log.warn('exec', '任务已经收口，回收它留下的 CLI 进程', {
      task: r.taskId,
      title: r.title,
      进程: r.pid,
      存活分钟: Math.round(r.aliveMs / 60_000),
    })
  }
  return reaped
}
