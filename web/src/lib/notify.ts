import { useEffect, useRef } from 'react'
import type { Task } from '@shared/schema'

const KEY = 'notify-task-done'

export const notifySupported = () => typeof Notification !== 'undefined'
export function notifyEnabled() {
  try {
    return notifySupported() && Notification.permission === 'granted' && localStorage.getItem(KEY) !== '0'
  } catch {
    return false
  }
}
/** 打开 / 关闭任务完成通知；打开时向浏览器申请权限，返回最终是否开启 */
export async function setNotify(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {}
  if (!on || !notifySupported()) return false
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  return p === 'granted'
}

const TEXT: Record<string, string> = { done: '已完成', failed: '失败了', stopped: '已暂停' }

/**
 * 任务从执行中变成完成 / 失败时：页面不在前台就发系统通知；标签页标题显示正在执行的任务数。
 * 跑很久的工作流不用一直盯着页面。
 */
export function useTaskNotifications(tasks: Task[], open: (t: Task) => void) {
  const prev = useRef(new Map<string, string>())
  const asked = useRef(new Set<string>())
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const before = prev.current
    const next = new Map(tasks.map((t) => [t.id, t.status]))
    prev.current = next
    const running = tasks.filter((t) => t.status === 'running').length
    document.title = running ? `(${running}) Agent 面板` : 'Agent 面板'
    // 新出现的确认请求：页面不在前台时也通知
    const reqs = new Set(tasks.flatMap((t) => (t.requests ?? []).map((r) => r.id)))
    const fresh = tasks.filter((t) => (t.requests ?? []).some((r) => !asked.current.has(r.id)))
    const first = !asked.current.size && !before.size
    asked.current = reqs
    if (!before.size || !document.hidden || !notifyEnabled()) return
    if (!first)
      for (const t of fresh)
        try {
          const n = new Notification('Agent 需要你确认', {
            body: `${t.title}：${t.requests[0].title}`,
            tag: `ask:${t.id}`,
          })
          n.onclick = () => {
            window.focus()
            openRef.current(t)
            n.close()
          }
        } catch {}
    for (const t of tasks) {
      if (before.get(t.id) !== 'running' || t.status === 'running' || !TEXT[t.status]) continue
      try {
        const n = new Notification(`任务${TEXT[t.status]}`, { body: t.title, tag: t.id })
        n.onclick = () => {
          window.focus()
          openRef.current(t)
          n.close()
        }
      } catch {
        // 有的浏览器（例如手机上）只允许 Service Worker 发通知
      }
    }
  }, [tasks])
}
