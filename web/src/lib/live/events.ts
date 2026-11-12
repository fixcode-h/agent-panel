import { useEffect, useRef, useState } from 'react'
import type { TaskLive } from '@shared/live/task-live'
import { putLive } from './store'
import { openPageStream } from './page-stream'

/** 事件流连不上多久之后改用轮询兜底：EventSource 自己会重连，短暂断开不用急着轮询 */
const FALLBACK_AFTER_MS = 5000

/**
 * 全局事件流（服务端 server/tasks/page-feed.ts）：和托盘信号共用页面事件流 /api/app/events 那一条连接（page-stream.ts）。
 * - `live`：顶层对话的运行时状态变了，直接放进 live/store.ts，侧栏、标题、项目首页跟着变；
 * - `tasks`：任务列表变了，调 onTasks 重新拉一次列表（带 ETag，没变就是 304）。
 * 重连上之后也拉一次：断开期间错过的变化补回来。
 *
 * 返回事件流现在通不通（down）：连不上（远程代理断开、服务重启中、在线演示没有后端）时
 * 调用方改用定时轮询兜底，连上了就停掉轮询。
 */
export function useServerEvents(onTasks: () => void) {
  const cb = useRef(onTasks)
  cb.current = onTasks
  // 在线演示没有服务端：一直按「连不上」处理，用轮询（演示后端在浏览器里，拉列表不费事）
  const [down, setDown] = useState(!!import.meta.env.VITE_DEMO)
  useEffect(() => {
    if (import.meta.env.VITE_DEMO || typeof EventSource === 'undefined') {
      setDown(true)
      return
    }
    const es = openPageStream()
    let lostAt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    es.on('live', (e) => {
      const lives = JSON.parse(e.data) as Record<string, TaskLive>
      for (const [id, live] of Object.entries(lives)) putLive(id, live)
    })
    es.on('tasks', () => cb.current())
    es.on('open', () => {
      clearTimeout(timer)
      setDown(false)
      // 断开后重连上：断开期间的列表变化补一次（第一次连上时列表刚取过，不重复）
      if (lostAt) cb.current()
      lostAt = 0
    })
    es.on('error', () => {
      if (lostAt) return
      lostAt = Date.now()
      clearTimeout(timer)
      timer = setTimeout(() => setDown(true), FALLBACK_AFTER_MS)
    })
    return () => {
      clearTimeout(timer)
      es.close()
    }
  }, [])
  return { down }
}
