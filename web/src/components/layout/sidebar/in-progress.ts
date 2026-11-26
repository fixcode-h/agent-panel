import type { Task } from '@shared/schema'
import type { TaskLive } from '@shared/live/task-live'
import { liveBusy } from '@shared/live/task-live'
import { planLeft } from '@shared/task'

/**
 * 归进「进行中」的对话：在执行、等结果（含名下工作流在跑）、等你处理，再加上停住了要你去看的——
 * 这一轮失败了、计划没做完且面板推了几次还停着（「卡住」）。后两种以前放在日期组里，只靠行尾的红色、琥珀色提醒，
 * 一多就被压下去（用户 2026-11-26 选的并进「进行中」）。只是「未完成」（面板还会推它接着做）的不算
 */
export function inProgress(tk: Task, l: TaskLive) {
  if (liveBusy(l) || l.state === 'needs' || l.state === 'failed') return true
  return l.state === 'unfinished' && !!planLeft(tk)?.stuck
}
