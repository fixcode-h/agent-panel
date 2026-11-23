/**
 * p4 / svn 的唯一运行入口（版本管理服务，ADR 0073）：面板里的 p4Runner、vcsRun 和插件经开放模块跑的 p4 都走这里。
 * 以前有四套写法（runProcess、execFile、UE 插件自己的 execFile、表格插件），UE 那套不设 PWD——p4 在 Unix 上按 PWD 找
 * .p4config，不设就连到面板启动目录的 client 上；也没法统一限流和计数，P4 服务器慢时一页打开能同时起几十个 p4。
 * git 不在这里：走 server/exec/git.ts（它有自己的锁和快照逻辑）
 */
import { spawn } from 'node:child_process'
import { childEnv } from '../exec/process.ts'
import { createGate } from '../slots.ts'

export type VcsCmd = 'p4' | 'svn'

/** 输出最大读这么多（旧版本的文件内容，和表格打开文件的上限一致） */
export const VCS_MAX_BYTES = 64 * 1024 * 1024
/** 同一种命令同时最多跑这么多个：P4 服务器慢的时候不至于一下压上几十个连接 */
const PARALLEL = 8
const DEFAULT_TIMEOUT_MS = 60_000

const gates = { p4: createGate(PARALLEL), svn: createGate(PARALLEL) } // 模块状态：运行时
/** 进程启动以来各命令跑了多少次：排查「谁在反复跑 p4」时看日志里的计数 */
const counts: Record<VcsCmd, number> = { p4: 0, svn: 0 } // 模块状态：运行时
export const vcsCallCounts = () => ({ ...counts })

export interface VcsResult {
  ok: boolean
  code: number | null
  stdout: Buffer
  stderr: string
  /** 没起来（没装 p4、不在 PATH 里） */
  spawnError?: string
  timedOut?: boolean
  /** 输出超过 maxBytes 被截断并结束了进程 */
  tooLarge?: boolean
}

export interface VcsExecOpts {
  stdin?: string
  timeoutMs?: number
  maxBytes?: number
}

export function vcsExec(cmd: VcsCmd, args: string[], cwd: string, o: VcsExecOpts = {}): Promise<VcsResult> {
  counts[cmd]++
  return gates[cmd](() => runOnce(cmd, args, cwd, o))
}

function runOnce(cmd: VcsCmd, args: string[], cwd: string, o: VcsExecOpts): Promise<VcsResult> {
  const max = o.maxBytes ?? VCS_MAX_BYTES
  return new Promise((resolve) => {
    const out: Buffer[] = []
    let size = 0
    let err = ''
    let timedOut = false
    let tooLarge = false
    let done = false
    const finish = (r: Omit<VcsResult, 'stdout' | 'stderr' | 'timedOut' | 'tooLarge'>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        ...r,
        stdout: Buffer.concat(out),
        stderr: err,
        ...(timedOut && { timedOut }),
        ...(tooLarge && { tooLarge }),
      })
    }
    const child = spawn(cmd, args, {
      cwd,
      // PWD 跟着 cwd：p4 在 Unix 上按 PWD（不是进程的 cwd）找 .p4config
      env: { ...childEnv([]), PWD: cwd },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size > max) {
        tooLarge = true
        child.kill()
        return
      }
      out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 1_000_000) err += d.toString('utf8')
    })
    child.on('error', (e) => finish({ ok: false, code: null, spawnError: e.message }))
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut && !tooLarge, code }))
    child.stdin.on('error', () => {
      // 进程先退出时写 stdin 会 EPIPE：结果按退出码算
    })
    child.stdin.end(o.stdin ?? '')
  })
}

/** 失败时给人看的一句原因：命令自己的 stderr 优先 */
export function vcsWhy(cmd: VcsCmd, args: string[], r: VcsResult) {
  if (r.spawnError) return `${cmd} 启动失败：${r.spawnError}`
  if (r.timedOut) return `${cmd} ${args[0] ?? ''}：超时没有结束`
  if (r.tooLarge) return `${cmd} ${args[0] ?? ''}：输出太大`
  return `${cmd} ${args[0] ?? ''}：${r.stderr.trim() || `退出码 ${r.code}`}`
}
