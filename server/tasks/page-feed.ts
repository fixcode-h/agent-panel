import type { Task } from '../../shared/schema.ts'
import { taskDeleted } from '../../shared/task.ts'
import type { TaskLive } from '../../shared/live/task-live.ts'
import { log } from '../log.ts'
import type { PageFeed } from '../page-events.ts'
import type { TasksScope } from './scope.ts'

/** 全局事件流多久比一次：和以前列表轮询（2.5 秒）比，变化最多晚 1 秒到 */
const EVENTS_TICK_MS = 1000

/**
 * 一次比较的结果：列表的指纹（变了页面就重新拉列表）和每个顶层对话的 live。
 * 只算顶层对话：侧栏、项目首页、标签页计数只列它们；子对话的 live 由打开的对话页各自的推送带
 */
interface Snapshot {
  list: string
  lives: Map<string, string>
}

/**
 * 全局事件流（重构文档第 8 条）：挂在页面事件流 /api/app/events 上（server/page-events.ts，一个页面只开一条），推
 * - `tasks`：任务列表变了（新建、删除、改名、状态、更新时间），页面重新拉一次列表（带 ETag）；
 * - `live`：顶层对话的运行时状态变了（server/tasks/live.ts 算的 TaskLive），只发变了的那几个。
 * 以前列表靠有任务在跑时每 2.5 秒轮询一次，进程退出、后台命令结束这类不改任务本身的变化要等下一次轮询。
 *
 * 比较只在一个定时器里做（不管开了几个页面）：有页面连着时每秒比一次，都断开了就停掉。
 * 断线时 EventSource 会自己重连，重连上的第一包带全部 live，页面再重新拉一次列表兜底（见 web/src/lib/live/events.ts）
 */
export function createTaskFeed(s: TasksScope): PageFeed {
  type Send = Parameters<PageFeed>[0]
  const conns = new Set<Send>()
  let last: Snapshot | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  /** 当前的列表指纹和每个顶层对话的 live（按内存里正在跑的那份算，和列表接口同一个口径） */
  async function snapshot(): Promise<Snapshot> {
    const all = (await s.store.list())
      .filter((t) => !taskDeleted(t) && !t.parentTaskId && !t.flowRun?.owner)
      .map((t) => s.live.get(t.id)?.task ?? t)
    const list = all.map(listKey).join('\n')
    const lives = new Map<string, string>()
    for (const t of all) lives.set(t.id, JSON.stringify(await s.liveOf(t)))
    return { list, lives }
  }

  async function tick() {
    if (ticking || !conns.size) return
    ticking = true
    try {
      const now = await snapshot()
      const prev = last
      last = now
      if (!prev) return
      const changed: Record<string, TaskLive> = {}
      for (const [id, l] of now.lives) if (prev.lives.get(id) !== l) changed[id] = JSON.parse(l) as TaskLive
      const events: [string, unknown][] = []
      if (now.list !== prev.list) events.push(['tasks', {}])
      if (Object.keys(changed).length) events.push(['live', changed])
      if (!events.length) return
      await Promise.all([...conns].map((send) => Promise.all(events.map(([e, d]) => send(e, d))).catch(() => {})))
    } catch (e) {
      log.warn('events', '全局事件流比较失败', { error: (e as Error).message })
    } finally {
      ticking = false
    }
  }

  return async (send) => {
    // 第一包：所有顶层对话当下的 live，页面据此对齐（断线期间错过的变化也一并补上）
    const now = await snapshot()
    if (!last) last = now
    const lives: Record<string, TaskLive> = {}
    for (const [id, l] of now.lives) lives[id] = JSON.parse(l) as TaskLive
    await send('live', lives).catch(() => {})
    conns.add(send)
    timer ??= setInterval(() => void tick(), EVENTS_TICK_MS)
    timer.unref?.()
    return () => {
      conns.delete(send)
      if (!conns.size && timer) {
        clearInterval(timer)
        timer = null
        last = null
      }
    }
  }
}

/** 列表里一行的指纹：这些变了侧栏就要重新拉列表（标题、状态、归档、置顶、更新时间……） */
const listKey = (t: Task) =>
  [
    t.id,
    t.updatedAt,
    t.status,
    t.working ? 1 : 0,
    t.awaitingUser ? 1 : 0,
    t.prewarming ? 1 : 0,
    t.archived ? 1 : 0,
    t.pinned ? 1 : 0,
    t.projectId,
    t.title,
    t.turnSeenAt,
  ].join('|')
