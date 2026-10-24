import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Task } from '@shared/schema'

const KEY = 'task-unread'

/**
 * 完成了但还没打开看过的对话。
 * 服务端记着 turnDoneAt / turnSeenAt，这里只缓存「这一轮完成、用户还没打开」的结果：
 * 打开对话时 TaskView 会让服务端标记已读，橙点随之消失，CLI 也随之可以按宽限期回收
 */
function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

let ids = read()
const listeners = new Set<() => void>()

function set(next: string[]) {
  ids = next
  try {
    if (next.length) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {}
  for (const l of listeners) l()
}

function markDone(id: string) {
  if (!ids.includes(id)) set([...ids, id])
}

/** 打开了这个对话：完成提示不用再留着 */
export function markTaskRead(id: string) {
  if (ids.includes(id)) set(ids.filter((x) => x !== id))
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useUnreadTasks() {
  return useSyncExternalStore(subscribe, () => ids)
}

/** 这一轮完成但用户还没打开看过：侧栏橙点、服务端据此保留 CLI 进程 */
export const isTaskUnread = (task: Pick<Task, 'turnDoneAt' | 'turnSeenAt' | 'jobs'>) =>
  // 交出去的后台命令还没跑完：这一轮说完了但对话还在等结果，不算「完成了没看」
  !!task.turnDoneAt && task.turnDoneAt !== task.turnSeenAt && !task.jobs?.length

/**
 * 项目里的对话完成一轮时，用户正开着它就不提示，开着别的页面就在侧栏标一个点。
 * 以 CLI 完成一轮的时间为准，不看进程是否结束：预热、等下一句、离开后 CLI 退出都不算完成。
 * 看没看过以服务端的 turnSeenAt 为准：换了浏览器、刷新页面之后状态也一致。
 * 第一次拿到的列表只记现状：页面打开时已经完成的任务不补标。
 */
export function useTaskDoneUnread(tasks: Task[], viewingId: string) {
  const prev = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (viewingId) markTaskRead(viewingId)
    const next = new Map(tasks.filter((t) => t.projectId).map((t) => [t.id, t.turnDoneAt ?? '']))
    const before = prev.current
    prev.current = next
    // 服务端已经标记看过的，本地也不用再留着
    for (const task of tasks) if (task.turnSeenAt === task.turnDoneAt) markTaskRead(task.id)
    if (!before) return
    for (const task of tasks) {
      if (!task.projectId || task.id === viewingId) continue
      if (!isTaskUnread(task)) continue
      // 新导入 / 新建的任务没有上一轮状态；这一轮已经看过的也不再提示
      const was = before.get(task.id)
      const done = task.turnDoneAt ?? ''
      if (was === undefined || was === done) continue
      markDone(task.id)
    }
  }, [tasks, viewingId])
}
