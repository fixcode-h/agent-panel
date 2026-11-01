import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 数据目录的单实例锁。
 *
 * 同一个数据目录只能有一个面板在跑：第二个实例一启动就会做启动迁移（把「在跑」的任务落成已中断、
 * 把正在合并的子对话退回收尾），等它再因为端口被占退出时，第一个实例的任务已经被改坏了；
 * 端口不同时两个实例会一直并存，计划双发、集合文件互相覆盖。所以要在读任何数据之前先拿锁。
 *
 * 锁文件里记 pid：持有者进程已经不在了（崩溃、被强杀）就是过期锁，直接接管。
 * 更新后重启时新进程和旧进程会短暂并存，等旧进程退出再拿（waitMs）。
 */
export interface LockHolder {
  pid: number
  startedAt: string
}

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (e) {
    // EPERM：进程在，只是不归我们管（别的用户），也算活着
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  // 崩溃后 pid 可能被别的程序复用：能看到命令行的系统（Linux）上，不是 node 进程就当过期锁
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return /node|tsx|server\.mjs/i.test(cmd)
  } catch {
    return true
  }
}

function readHolder(file: string): LockHolder | null {
  try {
    const h = JSON.parse(readFileSync(file, 'utf8')) as LockHolder
    return typeof h?.pid === 'number' ? h : null
  } catch {
    return null
  }
}

/** 同步等一小会儿：启动阶段还没有事件循环里的活要干，用 Atomics.wait 不占 CPU */
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * 拿锁：成功返回释放函数；被别的活着的实例占着返回持有者。
 * 用 'wx' 独占创建，两个实例同时启动时只有一个能建出来
 */
export function acquireInstanceLock(
  dataDir: string,
  opts: { waitMs?: number; pid?: number } = {},
): { ok: true; release: () => void } | { ok: false; holder: LockHolder } {
  const file = path.join(dataDir, 'panel.lock')
  const pid = opts.pid ?? process.pid
  const deadline = Date.now() + (opts.waitMs ?? 0)
  mkdirSync(dataDir, { recursive: true })
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { flag: 'wx' })
      return {
        ok: true,
        release: () => {
          // 只删自己的锁：被接管过（极端情况下）就不动别人的
          if (readHolder(file)?.pid === pid) rmSync(file, { force: true })
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const holder = readHolder(file)
    if (!holder || holder.pid === pid || !alive(holder.pid)) {
      // 过期锁（或写了一半读不出来的）：删掉重拿
      rmSync(file, { force: true })
      continue
    }
    if (Date.now() >= deadline) return { ok: false, holder }
    sleep(200)
  }
}
