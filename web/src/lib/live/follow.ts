/**
 * 对话页要不要跟着实时更新（SSE / 演示版轮询）：这一轮在跑、还列着后台命令、或者诊断报告在等确认时都要跟。
 * 从对话页（components/tasks/view/use-task-load.ts）收到这里：界面上的对话状态只在 lib / shared 的工具函数里拼
 */
import type { Task } from '@shared/schema'
import type { TaskLive } from '@shared/live/task-live'
import { diagnosisPending } from '@shared/task'

export function liveFollow(task: Task | null | undefined, live: TaskLive | undefined) {
  // 打开对话页不启动 CLI：只有真正发消息时才按当前选择启动，免得只是看一眼就起一堆进程
  const running = task?.status === 'running'
  // 还列着后台命令（等结果）时也要跟数据：命令跑完那一刻它从 jobs 里消失，
  // 不刷新的话界面上那一行会一直挂着「执行中」。正式版靠 SSE 推送，这里主要是演示版的轮询口径
  const jobRunning = (live?.jobs ?? []).some((j) => j.state === 'queued' || j.state === 'running')
  // 等确认诊断报告时也要跟：在弹窗里点「取消修复」不发消息，演示版靠轮询看到报告已取消、计划已完成
  const follow = running || jobRunning || (!!task && diagnosisPending(task))
  return { running, jobRunning, follow }
}
