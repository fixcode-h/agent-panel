import type { Task } from '@shared/schema'
import { retryModelPatch } from '@shared/task-run'
import type { RetryModelPick } from './api-retry'
import { handle } from './demo-backend'

/**
 * 在线演示里的「换个模型重试」：和正式后端同一份规则算出对话上要改的字段（shared/task-run.ts 的 retryModelPatch），
 * 先改进演示数据，再走演示后端自己的「继续」（模拟执行重发最后一条要求）。
 * 演示后端没有进程和预热，分两步不会像正式后端那样互相撞上
 */
export async function demoRetryWithModel(task: Pick<Task, 'id' | 'agentId' | 'effort'>, pick: RetryModelPick) {
  await handle('PATCH', `/tasks/${task.id}`, retryModelPatch(task, pick))
  return handle('POST', `/tasks/${task.id}/resume`, { latest: false }) as Promise<Task>
}
