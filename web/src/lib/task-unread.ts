import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Task } from '@shared/schema'

const KEY = 'task-unread'

/** 完成了但还没打开看过的对话；刷新页面后还记着，免得漏掉 */
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

/**
 * 项目里的对话执行完时，用户正开着它就不提示，开着别的页面就在侧栏标一个点。
 * 第一次拿到的列表只记现状：页面打开时已经完成的任务不补标。
 */
export function useTaskDoneUnread(tasks: Task[], viewingId: string) {
  const prev = useRef<Map<string, Task['status']> | null>(null)
  useEffect(() => {
    if (viewingId) markTaskRead(viewingId)
    const next = new Map(tasks.filter((t) => t.projectId).map((t) => [t.id, t.status]))
    const before = prev.current
    prev.current = next
    if (!before) return
    for (const task of tasks) {
      // 项目外的聊天不看，失败和暂停有各自的图标，只标完成
      if (!task.projectId || task.status !== 'done' || task.id === viewingId) continue
      // 新导入 / 新建的任务没有上一轮状态；已经完成过的也不再提示
      const was = before.get(task.id)
      if (was === undefined || was === 'done') continue
      markDone(task.id)
    }
  }, [tasks, viewingId])
}
