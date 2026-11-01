import { useEffect, useRef } from 'react'
import type { Task, TaskMessage } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from './api'

type Patch = { meta: Omit<Task, 'messages'>; messages: TaskMessage[]; total: number }

/** 把推送来的增量合到当前任务上：任务本身整体替换，消息按 id 替换或追加 */
export function mergePatch(task: Task, p: Patch): Task {
  const messages = task.messages.slice()
  // 流式输出时增量几乎都是最后一两条：先从尾部找，找不到再建全量索引。
  // 以前每个增量（每 200ms 一次）都给全部消息建一次 Map，长对话里白白 O(全部消息)
  const ix: { map?: Map<string, number> } = {}
  const find = (id: string) => {
    for (let i = messages.length - 1, n = 0; i >= 0 && n < 8; i--, n++) if (messages[i].id === id) return i
    ix.map ??= new Map(messages.map((m, i) => [m.id, i]))
    return ix.map.get(id)
  }
  for (const m of p.messages) {
    const i = find(m.id)
    if (i === undefined) {
      ix.map?.set(m.id, messages.length)
      messages.push(m)
    } else messages[i] = m
  }
  return { ...p.meta, messages } as Task
}

/**
 * 跟着任务的实时变化：服务端用 SSE 推送增量（见 server/tasks.ts 的 /tasks/:id/events），
 * 合并后交给 onTask。在线演示没有服务端，执行中时定时拉一次。
 *
 * boot：打开对话时先拿到的那一份（GET 的结果）和它的版本（整份都在它里面时才有）。
 * 有了它才建 SSE：带 rev 时服务端首包只补发最后一条，不用整份再传一遍；
 * 它同时是合并增量时的基线（patch 只带变化的消息）。
 *
 * hook：打开对话时的加载日志用（只有 TaskView 传）——首份完整任务到了 / 首包之前就连不上。
 * 演示版的轮询没有 SSE 的首包语义，改用 start / stop 包住轮询的生命周期：
 * 轮询在跑才算「在连实时更新」，停下来就把这一步收回来。打开时要不要记这一步由 TaskView
 * 按当时跑没跑判定一次（加载日志记的是这次打开），这里只管轮询自己的起停。
 */
export function useTaskStream(
  taskId: string,
  running: boolean,
  onTask: (t: Task) => void,
  hook?: { start?: () => void; open: () => void; fail: (error: string) => void; stop?: () => void },
  boot?: { rev: string; task: Task | null } | null,
) {
  const cb = useRef(onTask)
  cb.current = onTask
  const last = useRef<Task | null>(null)
  // 回调每次渲染都是新的，只存 ref，不进 effect 依赖（不然每次渲染都重连一遍 SSE）
  const hk = useRef(hook)
  hk.current = hook
  // 首包还没到时 EventSource 会反复报 error（它在自己重连），只记第一次
  const failed = useRef(false)
  // 已经收到过服务端的第一条事件（full 或 patch）：之后再断开是「重连中」，不算这次加载失败。
  // 不能拿 last.current 判：带上 boot 时它一开始就有基线，会把「首包前就连不上」盖掉
  const firstEvent = useRef(false)

  useEffect(() => {
    if (!import.meta.env.VITE_DEMO) return
    if (!running) return
    // 有轮询才算「在连实时更新」：从这里开始记，轮询停下时把这一步收回来（否则会一直显示「正在连接」）
    hk.current?.start?.()
    const t = setInterval(
      () =>
        api
          .task(taskId)
          .then((x) => {
            cb.current(x)
            // 演示版把轮询当作实时更新：第一份拉回来就算「连上了」，加载日志的这一步跟着完成；
            // 之后每次成功都走一遍（已完成的步骤不受影响），断过一次也能恢复
            hk.current?.open()
          })
          // 连不上就留下错误原文（收起后的加载日志胶囊会显示它），下一轮成功再恢复
          .catch((e) => hk.current?.fail((e as Error).message)),
      700,
    )
    return () => {
      clearInterval(t)
      hk.current?.stop?.()
    }
  }, [running, taskId])

  useEffect(() => {
    if (import.meta.env.VITE_DEMO) return
    // 第一份还没拿到（GET 还没回来）先不建连：没有基线，服务端发的增量合并不了
    if (!boot) return
    last.current = boot.task
    // 上一条对话首包前失败过时，这条对话的首次连接错误也要能报出来
    failed.current = false
    firstEvent.current = false
    // 手上有整份时带上版本：服务端能对上前缀就只补发增量（见 shared/task.ts 的 taskRevOffset）
    const rev = boot.rev ? `?rev=${encodeURIComponent(boot.rev)}` : ''
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events${rev}`)
    const emit = (t: Task) => {
      // 首包可能是 full 也可能是 patch（带 rev 建连时服务端只补发增量）：两种都算连上了
      if (!firstEvent.current) {
        firstEvent.current = true
        failed.current = false
        hk.current?.open()
      }
      last.current = t
      cb.current(t)
    }
    es.addEventListener('full', (e) => {
      emit(JSON.parse((e as MessageEvent).data))
    })
    es.addEventListener('patch', (e) => {
      const p = JSON.parse((e as MessageEvent).data) as Patch
      if (!last.current || last.current.id !== taskId) return
      const t = mergePatch(last.current, p)
      // 对不上（漏了一段）时重新取完整的
      if (t.messages.length !== p.total) {
        api
          .taskLite(taskId)
          .then(emit)
          .catch(() => {})
        return
      }
      emit(t)
    })
    es.addEventListener('gone', () => es.close())
    // 首包之前连不上才算这次加载失败（之后断开 EventSource 会自己重连，对话已经能看了）
    es.addEventListener('error', () => {
      if (firstEvent.current || failed.current) return
      failed.current = true
      hk.current?.fail(t('实时更新连接失败，正在重连'))
    })
    // 断开后 EventSource 会自己重连，重连时带上最后收到的事件 id，服务端只补发之后的变化
    return () => es.close()
  }, [taskId, boot])
}
