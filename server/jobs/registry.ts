/**
 * 后台作业注册表（ADR 0075）：面板和插件里能跑一阵子的事都在这登记，侧栏底部一处看全、看日志、取消。
 * 以前每类各管各的（UE 编译和安装挂在 globalThis 上防插件热升级丢表、模型下载各页轮询、文件索引自己推），
 * 用户不知道后台在跑什么，也没法统一取消。表放在面板进程里：插件升级重新加载也不丢。
 *
 * 状态有变化就推一次整份（停手 200 毫秒合并），页面不轮询。日志在内存里留最近 MAX_LINES 行，按行号增量取
 */
import type { BgJob, BgJobLog } from '../../shared/jobs/types.ts'
import { signalPages } from '../page-events.ts'

const MAX_LINES = 4000
/** 结束了的留这么多条，再多丢最早的 */
const KEEP_DONE = 30
const PUSH_MS = 200

export interface JobStart {
  /** panel 或插件 id */
  source: string
  projectId?: string
  kind: string
  title: string
  /** 给了就能取消：取消时调它（停子进程、断下载），作业由调用方照常 end */
  cancel?: () => void | Promise<void>
}

export interface JobHandle {
  id: string
  /** 追加日志（多行按换行拆） */
  log(text: string): void
  /** 更新进度和当前步骤 */
  progress(p: { phase?: string; done?: number; total?: number }): void
  /** 结束：ok 为 false 时 info 是原因；被取消的会记成 canceled */
  end(ok: boolean, info?: string): void
  /** 用户点了取消 */
  readonly canceled: boolean
}

interface Entry {
  job: BgJob
  lines: string[]
  /** 被丢掉的行数（行号从 0 一直往上数） */
  base: number
  cancel?: JobStart['cancel']
  canceled?: boolean
}

const jobs = new Map<string, Entry>() // 模块状态：运行时，面板重启后跑着的作业也没了
const listeners = new Set<(list: BgJob[]) => void>() // 模块状态：会话，订阅方自己撤
let pushTimer: ReturnType<typeof setTimeout> | undefined
let seq = 0

export const listJobs = (f: { projectId?: string; source?: string } = {}) =>
  [...jobs.values()]
    .map((e) => e.job)
    .filter((j) => (!f.projectId || j.projectId === f.projectId) && (!f.source || j.source === f.source))

function changed() {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = undefined
    const list = listJobs()
    signalPages({ type: 'bg-jobs', jobs: list })
    for (const l of listeners) l(list)
  }, PUSH_MS)
  pushTimer.unref?.()
}

/** 订阅整份变化（插件自己的页面要跟着显示时用）；返回撤掉的函数 */
export function onJobs(fn: (list: BgJob[]) => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

function trimDone() {
  const done = [...jobs.values()].filter((e) => e.job.status !== 'running')
  for (const e of done.slice(0, Math.max(0, done.length - KEEP_DONE))) jobs.delete(e.job.id)
}

export function startJob(o: JobStart): JobHandle {
  const id = `${Date.now().toString(36)}-${(++seq).toString(36)}`
  const e: Entry = {
    job: {
      id,
      source: o.source,
      ...(o.projectId ? { projectId: o.projectId } : {}),
      kind: o.kind,
      title: o.title,
      status: 'running',
      startedAt: Date.now(),
      cancelable: !!o.cancel,
      lines: 0,
    },
    lines: [],
    base: 0,
    cancel: o.cancel,
  }
  jobs.set(id, e)
  trimDone()
  changed()
  return {
    id,
    log(text) {
      for (const line of text.split(/\r?\n/)) if (line.trim()) e.lines.push(line)
      if (e.lines.length > MAX_LINES) {
        const drop = e.lines.length - MAX_LINES
        e.lines.splice(0, drop)
        e.base += drop
      }
      // 行数变了不推：日志一秒几百行，页面看日志时自己按行号取
      e.job.lines = e.base + e.lines.length
    },
    progress(p) {
      Object.assign(e.job, p)
      changed()
    },
    end(ok, info) {
      if (e.job.status !== 'running') return
      e.job.status = e.canceled ? 'canceled' : ok ? 'done' : 'failed'
      e.job.endedAt = Date.now()
      e.job.cancelable = false
      if (info) e.job.info = info
      changed()
    },
    get canceled() {
      return !!e.canceled
    },
  }
}

export function jobLog(id: string, from = 0): BgJobLog | undefined {
  const e = jobs.get(id)
  if (!e) return undefined
  const start = Math.max(0, from - e.base)
  return {
    lines: e.lines.slice(start),
    next: e.base + e.lines.length,
    ...(from < e.base ? { dropped: true } : {}),
  }
}

/** 取消：返回说明（成功或为什么不行） */
export async function cancelJob(id: string): Promise<{ ok: boolean; info: string }> {
  const e = jobs.get(id)
  if (!e) return { ok: false, info: 'not-found' }
  if (e.job.status !== 'running') return { ok: false, info: 'ended' }
  if (!e.cancel) return { ok: false, info: 'not-cancelable' }
  e.canceled = true
  e.job.cancelable = false
  changed()
  await e.cancel()
  return { ok: true, info: '' }
}

/** 清掉已经结束的（侧栏列表「清除已结束」） */
export function clearEnded() {
  for (const [id, e] of jobs) if (e.job.status !== 'running') jobs.delete(id)
  changed()
}
