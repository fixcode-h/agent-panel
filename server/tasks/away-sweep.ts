/**
 * 打开「我不在」时，把执行中的对话里已经挂着、能反悔又有推荐项的提问一起选掉（server/away.ts 的开关接口调用）。
 * 只看执行位里的对话：提问的回调跟着那一轮的进程，没在执行的对话没有能交回的地方
 */
import { trackWait } from '../../shared/task.ts'
import { onAwaySweep } from '../away.ts'
import { awayPickPending } from '../exec/away-pick.ts'
import type { TasksScope } from './scope.ts'

export function createAwaySweep(s: TasksScope) {
  onAwaySweep(async () => {
    for (const e of s.live.values()) {
      if (!awayPickPending(e.task)) continue
      e.task.updatedAt = new Date().toISOString()
      trackWait(e.task)
      await s.store.update(e.task.id, e.task)
    }
  })
}
