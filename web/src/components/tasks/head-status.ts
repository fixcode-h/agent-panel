/**
 * 对话页页签条右端的胶囊显示什么：运行中、等结果都只显示任务的累计执行时长，
 * 在等什么（子对话 / 后台命令 / 工作流）放进悬停提示和读屏说明里。
 * 计时口径只认 shared/task.ts 的 taskDuration（已完成的几段 + 正在跑的这段），
 * 不按「最后一条用户消息」算——那样长会话每发一句就从头计时，用户看到的是 0:23 而不是实际跑了多久。
 */
import { pad2 } from '@shared/datetime'
import type { Task } from '@shared/schema'
import { taskDuration, type TaskFactsInput } from '@shared/task'
import { liveWord, type TaskLive } from '@shared/task-live'

/** 胶囊要读的任务字段：计时用 taskDuration 需要的几个时间字段（状态读服务端给的 live） */
export type HeadStatusTask = TaskFactsInput & Pick<Task, 'runMs' | 'runStartedAt' | 'createdAt' | 'updatedAt'>

export interface HeadStatusView {
  /** 胶囊里唯一的文字：累计执行时长（3:12、1:02:05） */
  text: string
  tone: 'run' | 'wait'
  /** 运行中 / 等结果转圈；等你处理不转（那是要用户动作，不是在跑） */
  spin: boolean
  /** 悬停提示和读屏说明：等结果时写清在等什么，后面跟已运行时长 */
  hint: string
}

/** 秒数写成时钟样式（3:12、1:02:05）：页签条右端的胶囊位置窄，比「3m 12s」更紧凑 */
export function clock(ms: number) {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h}:${pad2(m)}:${pad2(sec % 60)}` : `${m}:${pad2(sec % 60)}`
}

/**
 * 页签条右端的状态胶囊：运行中 / 等结果只显示累计执行时长；
 * 有提问、请求等你时保留琥珀色的一句话（这一页没有确认卡，用户要知道该去哪儿），时长放进提示。
 * 状态只读服务端给的 live（shared/task-live.ts），不另判。
 */
export function headStatus(task: HeadStatusTask, live: TaskLive, now = Date.now()): HeadStatusView | null {
  // 状态和短词都从 live 取（分析稿 A8）：侧栏、输入框占位、会话栏写的是同一个词
  const { state } = live
  const word = liveWord(live)
  const elapsed = clock(taskDuration(task, now))
  if (state === 'running' || state === 'waiting')
    return { text: elapsed, tone: 'run', spin: true, hint: `${word} · ${elapsed}` }
  if (state === 'needs') return { text: word, tone: 'wait', spin: false, hint: `${word} · ${elapsed}` }
  return null
}
