import type { HookEventName } from '@shared/hook-defs'
import { t } from '@shared/i18n'

/** 钩子事件在界面上的叫法（设置页「钩子」、AI 创建的预览共用） */
const LABELS: Record<HookEventName, () => string> = {
  'turn.beforeEnd': () => t('结束前'),
  'tool.before': () => t('工具前'),
  'tool.after': () => t('工具后'),
  'context.restored': () => t('压缩后'),
  'task.done': () => t('对话完成'),
  'task.failed': () => t('对话失败'),
  'task.waitingUser': () => t('等你回复'),
  'task.wrapRequested': () => t('请求收尾'),
  'plan.stepDone': () => t('计划完成一步'),
  'schedule.finished': () => t('计划任务跑完'),
}

export function eventLabel(e: HookEventName | string): string {
  return LABELS[e as HookEventName]?.() ?? e
}

/** 每个事件一句话说明：什么时候触发、能做什么 */
const HINTS: Record<HookEventName, () => string> = {
  'turn.beforeEnd': () => t('模型准备结束这一轮时；可以拦住，让它在同一轮里接着做'),
  'tool.before': () => t('工具执行前；可以拒绝这次调用，或补一段说明'),
  'tool.after': () => t('工具返回后；可以补一段说明'),
  'context.restored': () => t('压缩上下文、续接之后；可以补一段说明'),
  'task.done': () => t('对话完成一轮时；只通知，输出不看'),
  'task.failed': () => t('对话执行失败时；只通知，输出不看'),
  'task.waitingUser': () => t('对话停下来等你回复或确认时；只通知，输出不看'),
  'task.wrapRequested': () => t('子对话请父对话收尾时；只通知，输出不看'),
  'plan.stepDone': () => t('计划里的某一步做完时；只通知，输出不看'),
  'schedule.finished': () =>
    t('计划任务成功启动、启动失败、错过或上游没成功时；只通知，HTTP 钩子失败会重试，结果记在计划上'),
}

export const eventHint = (e: HookEventName) => HINTS[e]()

export const HOOK_EVENTS = Object.keys(LABELS) as HookEventName[]
