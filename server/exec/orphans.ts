import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 */
const FILE = path.join(DATA_DIR, 'run', 'cli-pids.json')

/** 这条 CLI 是哪个对话（含子对话、子任务、工作流）起的：taskId 是执行它的那个任务，rootTaskId 是对话树的最上层 */
export type TrackedOwner = { taskId: string; rootTaskId: string; title: string }

/** 一条登记：pid、命令行（拼好的，日志和判定用）、工作目录、开始时间 */
export type TrackedCli = {
  pid: number
  argv: string
  cwd: string
  startedAt: number
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

/** 读登记文件；坏了当作没有，不会因为一个坏文件起不来 */
function read(): TrackedCli[] {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as { processes?: unknown }
    const list = Array.isArray(raw.processes) ? raw.processes : []
    return list.filter(
      (x): x is TrackedCli =>
        !!x && typeof x === 'object' && Number.isInteger((x as TrackedCli).pid) && (x as TrackedCli).pid > 0,
    )
  } catch {
    return []
  }
}

function write(list: TrackedCli[]) {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify({ processes: list }))
  } catch (e) {
    // 写不进去只是少了一次清理机会，不影响执行
    log.warn('exec', 'CLI 进程登记文件写不进去', { error: (e as Error).message })
  }
}

/**
 * 登记在内存里留一份，文件只在有变化时写。以前每个进程结束（包括 git status 这类短命令）都要同步读一遍文件，
 * 子对话一多、git 查询一频繁，事件循环上就全是同步读盘
 */
let mem: TrackedCli[] | null = null
const tracked = () => (mem ??= read())

/** 面板起了一个带自己痕迹的 CLI：记下来，面板被强杀后下次启动能认出来 */
export function trackCliProcess(pid: number, argv: string, cwd: string, owner?: TrackedOwner) {
  const now = Date.now()
  const list = tracked().filter((x) => x.pid !== pid)
  list.push({ pid, argv, cwd, startedAt: now, lastOutputAt: now, ...(owner ? { owner } : {}) })
  mem = list
  write(list)
}

/** 这个进程还有输出（stdout 每一行、stderr 每一块都会走到）：只更新内存，不写盘 */
export function touchCliProcess(pid: number) {
  const e = tracked().find((x) => x.pid === pid)
  if (e) e.lastOutputAt = Date.now()
}

/** 当前登记的进程（副本）；内存采样的每一点都读它，不能把内部数组交出去 */
export function trackedClis(): TrackedCli[] {
  return tracked().map((x) => ({ ...x }))
}

/** 这条登记现在还在不在 */
export function isTrackedCli(pid: number) {
  return tracked().some((x) => x.pid === pid)
}

/** 进程正常结束了：从登记里去掉（不在登记里时不碰文件，短命令很多） */
export function untrackCliProcess(pid: number) {
  const list = tracked()
  if (!list.some((x) => x.pid === pid)) return
  mem = list.filter((x) => x.pid !== pid)
  write(mem)
}

/** 面板正常退出：CLI 已经由 killAllProcesses 停掉，登记清空 */
export function clearTrackedClis() {
  mem = []
  write([])
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

/**
 * 启动时清理上次强杀留下的 CLI：只处理登记过、现在还在、且命令行仍带面板痕迹的进程。
 * 已经结束的、或者 pid 被别的进程复用（命令行不像面板起的）都不动，只写日志。
 * kill 由调用方传入（process.ts 的 killTree），避免这里和进程管理互相 import
 */
export async function cleanStaleCliProcesses(kill: (pid: number) => void): Promise<void> {
  const stale = tracked()
  if (!stale.length) return
  const all = await listProcesses()
  let killed = 0
  for (const e of stale) {
    const argv = all.get(e.pid)
    // 已经结束了：清掉登记就行
    if (argv === undefined) continue
    if (!looksLikePanelCli(argv)) {
      log.warn('exec', '登记的 pid 现在跑的进程不像面板起的，跳过（pid 可能被复用）', {
        pid: e.pid,
        argv: argv.slice(0, 300),
      })
      continue
    }
    kill(e.pid)
    killed++
    log.warn('exec', '清理上次留下的 CLI 进程', { pid: e.pid, argv: argv.slice(0, 300), cwd: e.cwd })
  }
  clearTrackedClis()
  log.info('exec', '启动清理遗留 CLI 完成', { 登记: stale.length, 清理: killed })
}
