import { useEffect, useRef } from 'react'
import type { Task, TaskMessage } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from './api'

type Patch = { meta: Omit<Task, 'messages'>; messages: TaskMessage[]; total: number }

/** 把推送来的增量合到当前任务上：任务本身整体替换，消息按 id 替换或追加 */
export function mergePatch(task: Task, p: Patch): Task {
  const messages = task.messages.slice()
  const index = new Map(messages.map((m, i) => [m.id, i]))
  for (const m of p.messages) {
    const i = index.get(m.id)
    if (i === undefined) {
      index.set(m.id, messages.length)
      messages.push(m)
    } else messages[i] = m
  }
  return { ...p.meta, messages } as Task
}

/**
 * 跟着任务的实时变化：服务端用 SSE 推送增量（见 server/tasks.ts 的 /tasks/:id/events），
 * 合并后交给 onTask。在线演示没有服务端，执行中时定时拉一次。
 *
 * hook：打开对话时的加载日志用（只有 TaskView 传）——首份完整任务到了 / 首包之前就连不上。
 */
export function useTaskStream(
  taskId: string,
  running: boolean,
  onTask: (t: Task) => void,
  hook?: { open: () => void; fail: (error: string) => void },
) {
  const cb = useRef(onTask)
  cb.current = onTask
  const last = useRef<Task | null>(null)
  // 回调每次渲染都是新的，只存 ref，不进 effect 依赖（不然每次渲染都重连一遍 SSE）
  const hk = useRef(hook)
  hk.current = hook
  // 首包还没到时 EventSource 会反复报 error（它在自己重连），只记第一次
  const failed = useRef(false)

  useEffect(() => {
    if (!import.meta.env.VITE_DEMO) return
    if (!running) return
    const t = setInterval(
      () =>
        api
          .task(taskId)
          .then((x) => cb.current(x))
          .catch(() => {}),
      700,
    )
    return () => clearInterval(t)
  }, [running, taskId])

  useEffect(() => {
    if (import.meta.env.VITE_DEMO) return
    last.current = null
    // 上一条对话首包前失败过时，这条对话的首次连接错误也要能报出来
    failed.current = false
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`)
    const emit = (t: Task) => {
      last.current = t
      cb.current(t)
    }
    es.addEventListener('full', (e) => {
      failed.current = false
      hk.current?.open()
      emit(JSON.parse((e as MessageEvent).data))
    })
    es.addEventListener('patch', (e) => {
      const p = JSON.parse((e as MessageEvent).data) as Patch
      if (!last.current || last.current.id !== taskId) return
      const t = mergePatch(last.current, p)
      // 对不上（漏了一段）时重新取完整的
      if (t.messages.length !== p.total) {
        api
          .task(taskId)
          .then(emit)
          .catch(() => {})
        return
      }
      emit(t)
    })
    es.addEventListener('gone', () => es.close())
    // 首包之前连不上才算这次加载失败（之后断开 EventSource 会自己重连，对话已经能看了）
    es.addEventListener('error', () => {
      if (last.current || failed.current) return
      failed.current = true
      hk.current?.fail(t('实时更新连接失败，正在重连'))
    })
    // 断开后 EventSource 会自己重连，重连后服务端先发完整任务
    return () => es.close()
  }, [taskId])
}
