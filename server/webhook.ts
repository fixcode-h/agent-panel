/**
 * 计划任务跑到终态（成功启动 / 启动失败 / 错过 / 上游没成功）时交给钩子的那份结果（ADR 0049 第三期）。
 * 原来是设置里单独的「计划 Webhook」，现在是钩子事件 schedule.finished：投递（超时、重试、记进 Schedule.lastDelivery）
 * 在 server/hooks/notify.ts，这里只拼载荷：字段和原来的 Webhook 一样，放在钩子输入的 schedule 下（event 改叫 result，
 * 钩子输入的 event 是 schedule.finished）
 */
import { t } from '../shared/i18n.ts'
import { whenLabel, type Schedule, type ScheduleEvent } from '../shared/schedule.ts'

/**
 * 投递出去的 JSON：能对上是哪个计划、哪一轮、结果如何。
 * 字段名写全（不缩写成 pid / ts 这类），接的一方不用看代码猜。
 */
export interface WebhookPayload {
  /** run 成功启动 / fail 启动失败 / miss 错过 / blocked 上游没成功 */
  event: ScheduleEvent
  scheduleId: string
  name: string
  projectId: string
  /** 项目名；聊天模式或项目已被删掉时为空 */
  projectName: string
  repeat: string
  /** 这一轮到点的时间（ISO）：失败 / 错过 / 没启动时就是它 */
  at: string
  /** 成功启动时的对话 id，其余为空 */
  taskId: string
  /** 失败 / 没启动 / 错过的原因，成功时为空 */
  error: string
  /** 发出这份载荷的时间（ISO） */
  sentAt: string
}

/** 拼一份载荷：纯函数，服务端和单测都用它 */
export function webhookPayload(
  s: Schedule,
  event: ScheduleEvent,
  /** 这一轮到点的时间（计划成功后 at 已经推到下一次，不能再用 s.at） */
  at: string,
  projectName = '',
  now = Date.now(),
): WebhookPayload {
  return {
    event,
    scheduleId: s.id,
    name: s.name,
    projectId: s.projectId,
    projectName,
    repeat: s.repeat,
    at,
    taskId: event === 'run' ? s.lastTaskId : '',
    error: eventError(s, event, at),
    sentAt: new Date(now).toISOString(),
  }
}

/**
 * 这一轮事件的原因。别用 lastError 当通用兜底：启动失败后 lastError 会一直留着，
 * 后面一次的「错过」「上游没成功」会被写成上一次的失败原因，接的一方对不上号。
 * at 是这一轮的到点时间：用户同时改过排期时 writeBack 会丢掉 missedAt，
 * 这时用 at 当错过的那一次，不能把时间位置空着。
 */
function eventError(s: Schedule, event: ScheduleEvent, at: string): string {
  switch (event) {
    case 'run':
      return ''
    case 'fail':
      return s.lastError
    case 'miss':
      return t('错过 {time}（面板当时没在跑，不补跑）', { time: whenLabel(s.missedAt || at) })
    case 'blocked':
      return s.blockedReason || t('上游没有成功，没有启动')
  }
}
