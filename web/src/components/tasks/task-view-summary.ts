/** 对话页往全局任务列表写摘要的节流：从 TaskView.tsx 拆出来（文件行数上限，见 docs/lessons/file-caps.md） */
import { useRef } from 'react'
import type { Task } from '@shared/schema'
import { taskSummary } from '@shared/task'
import type { TaskPage } from '@/lib/api'
import { windowedForSummary } from '@/components/tasks/summary-window'

export function useSummaryPush(tasks: Task[], upsertTask: (t: Task) => void) {
  // 流式输出每 200ms 推一次：任务本身马上换（对话要实时显示），全局列表的摘要最多 1 秒写一次。
  // 状态、标题、等待确认这些侧栏马上要反映的变化仍然立即写
  const lastTask = useRef<Task | null>(null)
  // 手上这份是不是只有最近一段（见 OPEN_MESSAGE_LIMIT）：从截断恢复到整份时摘要要立刻写
  const truncated = useRef(false)
  const summaryAt = useRef(0)
  const summaryTimer = useRef<number | undefined>(undefined)
  // 列表里的摘要只放第一条用户消息（侧栏预览、搜索都读它）：手上只有最近一段时，消息这一项
  // 沿用列表里已有的那份，别把预览换成尾部那一条；其余字段（未读清掉、状态、子对话计数）照常写，
  // 侧栏马上要反映的变化不能等整份到齐
  const summaryOf = (next: TaskPage): Task =>
    next.messageHasMore
      ? taskSummary(
          windowedForSummary(
            next,
            tasks.find((x) => x.id === next.id),
          ),
        )
      : taskSummary(next)
  const pushSummary = (next: TaskPage, force = false) => {
    const prev = lastTask.current
    lastTask.current = next
    const important =
      force ||
      !prev ||
      prev.id !== next.id ||
      prev.title !== next.title ||
      prev.status !== next.status ||
      prev.working !== next.working ||
      prev.turnDoneAt !== next.turnDoneAt ||
      // 未读清掉（打开对话时）也是侧栏马上要反映的变化，不能等 1 秒节流
      prev.turnSeenAt !== next.turnSeenAt ||
      // 子对话计数、后台命令这些运行时状态不经摘要：它们在 live-store 里，侧栏直接订阅
      (prev.requests?.length ?? 0) !== (next.requests?.length ?? 0)
    const now = Date.now()
    if (important || now - summaryAt.current >= 1000) {
      summaryAt.current = now
      if (summaryTimer.current) {
        clearTimeout(summaryTimer.current)
        summaryTimer.current = undefined
      }
      // 全局列表只放摘要，侧栏不用跟着每段输出重新渲染消息
      upsertTask(summaryOf(next))
      return
    }
    if (summaryTimer.current) return
    summaryTimer.current = window.setTimeout(() => {
      summaryTimer.current = undefined
      summaryAt.current = Date.now()
      if (lastTask.current) upsertTask(summaryOf(lastTask.current))
    }, 1000)
  }
  return { lastTask, truncated, summaryTimer, pushSummary }
}
