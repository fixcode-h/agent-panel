import os from 'node:os'
import { isViewing } from '../presence.ts'
import { log } from '../log.ts'
import { taskLog } from './log.ts'
import { getSettings } from '../settings.ts'
import { trackedClis } from '../exec/orphans.ts'
import { processSnapshot, subtree, sumRss } from '../exec/proc-stats.ts'
import type { TasksScope } from './scope.ts'

/**
 * 保活中的空闲会话：列出来（设置「数据」）、手动释放、内存紧张时自动释放。
 *
 * 保活不再有数量上限（用户 2026-11-02 决定，见 docs/lessons/process.md），空闲对话多了以后每个都挂着
 * 一个 CLI 进程（连同它拉起的 MCP 服务，几百 MB 到上 GB），机器内存被吃满时整台电脑和面板一起卡死。
 * 这里不加回数量上限，只在系统可用内存真的低于设置的比例时，把没开着页面的空闲会话放掉，
 * 下次发消息时冷启动续接原会话（和手动「释放」同一条路）
 */

/** 多久看一次系统内存 */
export const MEMORY_CHECK_MS = 30_000
/** 自动释放过一次后，至少隔这么久才再放：刚结束的进程内存要过一会儿才还给系统，连着判会把新开的也放掉 */
export const MEMORY_RELEASE_COOLDOWN_MS = 3 * 60_000

export type KeepAliveItem = {
  id: string
  title: string
  projectId?: string
  parentTaskId?: string
  cli: string
  viewing: boolean
  since: string
  rss: number | null
}

/**
 * 系统可用内存的比例（0–100）。macOS 上 os.freemem 不算可回收的缓存页，平时就只剩几个百分点，
 * 按它判会一直误判成内存紧张，所以只在 Windows / Linux 上给数（它们报的是「可用」内存）
 */
export function freeMemoryPercent(platform = process.platform, free = os.freemem(), total = os.totalmem()) {
  if (platform === 'darwin' || !total) return null
  return (free / total) * 100
}

/** 可用内存低于设置的比例时要不要释放：0 表示关掉；释放过一次后冷却期内不再放 */
export function shouldReleaseForMemory(o: {
  percent: number | null
  threshold: number
  now: number
  lastRelease: number
}) {
  if (!o.threshold || o.percent === null) return false
  if (o.percent >= o.threshold) return false
  return o.now - o.lastRelease >= MEMORY_RELEASE_COOLDOWN_MS
}

export function createIdleRelease(s: TasksScope) {
  /** 回复完停在等下一句、CLI 进程还留着的对话，连同进程（含子进程）占的内存，最早空下来的在前 */
  async function keepAliveList(): Promise<KeepAliveItem[]> {
    const map = await processSnapshot()
    const tracked = trackedClis()
    return [...s.live.values()]
      .filter((e) => e.task.awaitingUser && !e.task.working)
      .map((e) => {
        const pids = new Set<number>()
        for (const x of tracked.filter((x) => x.owner?.taskId === e.task.id))
          for (const pid of map ? subtree(x.pid, map) : [x.pid]) pids.add(pid)
        return {
          id: e.task.id,
          title: e.task.title,
          projectId: e.task.projectId,
          parentTaskId: e.task.parentTaskId,
          cli: e.task.sessionCli || e.task.cli,
          viewing: isViewing(e.task.id),
          since: e.task.turnDoneAt || e.task.updatedAt,
          rss: map && pids.size ? sumRss(pids, map) : null,
        }
      })
      .sort((a, b) => a.since.localeCompare(b.since))
  }

  /** 释放保活的会话：给了 only 就只放这几个，否则放掉所有没开着页面的 */
  async function releaseIdle(only: Set<string> | null) {
    const released: KeepAliveItem[] = []
    for (const x of await keepAliveList()) {
      if (only ? !only.has(x.id) : x.viewing) continue
      // 名下有子对话在跑的父对话不动：结束它会把子对话一起停掉
      if ([...s.live.values()].some((e) => e.task.parentTaskId === x.id && e.task.working)) continue
      s.stopTask(x.id, 'idle')
      released.push(x)
    }
    return released
  }

  let lastRelease = 0
  /** 内存紧张但没有能放的空闲会话时只记一次日志，内存恢复后再重新记 */
  let toldNothing = false

  /** 看一次系统内存，低于设置的比例就放掉没开着页面的空闲会话 */
  async function checkMemory(o: { now?: number; percent?: number | null; threshold?: number } = {}) {
    const now = o.now ?? Date.now()
    const percent = o.percent === undefined ? freeMemoryPercent() : o.percent
    const threshold = o.threshold ?? (await getSettings()).lowMemoryReleasePercent
    if (percent === null || !threshold || percent >= threshold) {
      toldNothing = false
      return []
    }
    if (!shouldReleaseForMemory({ percent, threshold, now, lastRelease })) return []
    const released = await releaseIdle(null)
    const free = `${percent.toFixed(1)}%`
    if (!released.length) {
      if (!toldNothing)
        log.warn('task', '系统可用内存不足，但没有可以释放的空闲 Agent', { 可用内存: free, 阈值: `${threshold}%` })
      toldNothing = true
      return []
    }
    lastRelease = now
    toldNothing = false
    const mb = released.reduce((n, x) => n + (x.rss ?? 0), 0) / 1024 / 1024
    for (const x of released) taskLog(x.id, '系统内存不足，释放空闲 Agent', { 可用内存: free, rss: x.rss ?? undefined })
    log.warn('task', '系统可用内存不足，释放了空闲 Agent', {
      可用内存: free,
      阈值: `${threshold}%`,
      对话: released.length,
      约释放MB: Math.round(mb),
    })
    return released
  }

  /** 定时看内存；返回停止函数（服务退出时调） */
  function startMemoryGuard() {
    const timer = setInterval(() => {
      void checkMemory().catch((e) => log.warn('task', '检查系统内存失败', { error: (e as Error).message }))
    }, MEMORY_CHECK_MS)
    timer.unref()
    return () => clearInterval(timer)
  }

  return { keepAliveList, releaseIdle, checkMemory, startMemoryGuard }
}
