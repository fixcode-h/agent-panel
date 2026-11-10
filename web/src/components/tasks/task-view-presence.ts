/**
 * 对话页告诉服务端「看过了 / 还开着」：打开时记已读、这一轮完成时页面正开着也记已读、在场心跳和离开时的信标。
 * 从 TaskView.tsx 拆出来（文件行数上限，见 docs/lessons/file-caps.md），三段 effect 的先后和原来一样
 */
import { useEffect, useRef } from 'react'
import type { TaskSeenResult } from '@shared/schema'
import { api, type TaskPage } from '@/lib/api'
import type { useLoadTrace } from '@/lib/useLoadTrace'

export function useTaskPresence(
  taskId: string,
  task: TaskPage | null,
  trace: ReturnType<typeof useLoadTrace>,
  applySeen: (seen: TaskSeenResult) => void,
) {
  // 打开了这个对话：告诉服务端这一轮已经看过（侧栏的橙点消失），
  // 之后离开时 CLI 才能按宽限期回收；没看过就一直留着，回来能直接接着说
  const marked = useRef('')
  useEffect(() => {
    if (marked.current === taskId) return
    marked.current = taskId
    trace.start('seen')
    api
      .markTaskSeen(taskId)
      .then((seen) => {
        trace.finish('seen')
        applySeen(seen)
      })
      // 标记已读失败不影响看对话：只在日志里标红并显示原文，不弹提示
      .catch((e) => trace.fail('seen', (e as Error).message))
    // 只在换到新的对话时报一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // 这一轮完成时页面正开着：直接记为看过，不亮橙点。
  // 不能只靠服务端的在场记录：那是内存里的，面板重启过就没了，用户明明开着却还是标成未读
  useEffect(() => {
    const done = task?.turnDoneAt ?? ''
    if (!done || done === task?.turnSeenAt) return
    const mark = () => {
      // 切到后台时不算看过，等用户切回来再记
      if (document.hidden) return
      api
        .markTaskSeen(taskId)
        .then(applySeen)
        .catch(() => {})
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
    // apply 每次渲染都是新的，只按这一轮完成和看过的时间重跑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.turnDoneAt, task?.turnSeenAt, taskId])

  // 告诉服务端这个对话页还开着：CLI 回复完会停在等下一句的工具上；宽限期内切回来还能接着说（时长在设置里改）
  useEffect(() => {
    const viewer = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
    const send = (active: boolean) => {
      void api.setPresence(taskId, viewer, active).catch(() => {})
    }
    send(true)
    const visibility = () => send(!document.hidden)
    const hide = () => {
      // 在线演示没有后端，不用发
      if (import.meta.env.VITE_DEMO) return
      const body = JSON.stringify({ viewerId: viewer, active: false })
      navigator.sendBeacon?.(
        `/api/tasks/${encodeURIComponent(taskId)}/presence`,
        new Blob([body], { type: 'application/json' }),
      )
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
      send(false)
    }
  }, [taskId])
}
