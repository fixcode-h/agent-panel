/**
 * 对话页页签条右端的胶囊显示什么：运行中、等结果都只显示任务的累计执行时长，
 * 在等什么（子对话 / 后台命令 / 工作流）放进悬停提示和读屏说明里。
 * 计时口径只认 shared/task.ts 的 taskDuration（已完成的几段 + 正在跑的这段），
 * 不按「最后一条用户消息」算——那样长会话每发一句就从头计时，用户看到的是 0:23 而不是实际跑了多久。
 */
import { pad2 } from '@shared/datetime'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { taskDuration, taskState, taskWaitText, type TaskFactsInput } from '@shared/task'

/** 胶囊要读的任务字段：状态判定用 TaskFactsInput，计时用 taskDuration 需要的几个时间字段 */
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
 * 状态只从 taskState 派生，不另判。
 */
export function headStatus(task: HeadStatusTask, now = Date.now()): HeadStatusView | null {
  const state = taskState(task)
  const elapsed = clock(taskDuration(task, now))
  if (state === 'running' || state === 'waiting') {
    const wait = state === 'waiting' ? taskWaitText(task) : ''
    return {
      text: elapsed,
      tone: 'run',
      spin: true,
      hint: `${wait || t('运行中')} · ${elapsed}`,
    }
  }
  if (state === 'needs') {
    const text = taskWaitText(task) || t('等你回复')
    return { text, tone: 'wait', spin: false, hint: `${text} · ${elapsed}` }
  }
  return null
}
