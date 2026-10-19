import { useEffect, useRef } from 'react'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { setBaseTitle } from './page-signal'

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

const TEXT: Record<string, string> = { done: t('任务已完成'), failed: t('任务失败了'), stopped: t('任务已暂停') }

/**
 * 任务从执行中变成完成 / 失败时：页面不在前台就发系统通知；标签页标题显示正在执行的任务数。
 * 跑很久的工作流不用一直盯着页面。
 */
export function useTaskNotifications(tasks: Task[], open: (task: Task) => void) {
  const prev = useRef(new Map<string, { status: Task['status']; done: string }>())
  const asked = useRef(new Set<string>())
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const before = prev.current
    const next = new Map(tasks.map((task) => [task.id, { status: task.status, done: task.turnDoneAt ?? '' }]))
    prev.current = next
    // 标题里的数量只在 CLI 真的处理时算，预热/等下一句不算
    const running = tasks.filter((task) => task.working).length
    setBaseTitle(running ? `(${running}) ${t('Agent 面板')}` : t('Agent 面板'))
    // 新出现的确认请求：页面不在前台时也通知
    const reqs = new Set(tasks.flatMap((task) => (task.requests ?? []).map((r) => r.id)))
    const fresh = tasks.filter((task) => (task.requests ?? []).some((r) => !asked.current.has(r.id)))
    const first = !asked.current.size && !before.size
    asked.current = reqs
    if (!before.size || !document.hidden || !notifyEnabled()) return
    if (!first)
      for (const task of fresh)
        try {
          const n = new Notification(t('Agent 需要你确认'), {
            body: t('{task}：{request}', { task: task.title, request: task.requests[0].title }),
            tag: `ask:${task.id}`,
          })
          n.onclick = () => {
            window.focus()
            openRef.current(task)
            n.close()
          }
        } catch {}
    for (const task of tasks) {
      const was = before.get(task.id)
      if (!was) continue
      // 完成以 CLI 完成一轮为准：预热、等下一句、切走后进程退出都不算
      const doneTurn = !!task.turnDoneAt && task.turnDoneAt !== was.done
      const ended = was.status === 'running' && (task.status === 'failed' || task.status === 'stopped')
      if (!ended && !doneTurn) continue
      const text = ended ? TEXT[task.status] : TEXT.done
      try {
        const n = new Notification(text, { body: task.title, tag: task.id })
        n.onclick = () => {
          window.focus()
          openRef.current(task)
          n.close()
        }
      } catch {
        // 有的浏览器（例如手机上）只允许 Service Worker 发通知
      }
    }
  }, [tasks])
}
