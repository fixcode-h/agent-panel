import type { HookEventName } from '@shared/hook-defs'
import { t } from '@shared/i18n'

/** 钩子事件在界面上的叫法（设置页「钩子」、AI 创建的预览共用） */
export function eventLabel(e: HookEventName | string): string {
  return e === 'turn.beforeEnd'
    ? t('结束前')
    : e === 'tool.before'
      ? t('工具前')
      : e === 'tool.after'
        ? t('工具后')
        : e === 'context.restored'
          ? t('压缩后')
          : e
}

/** 每个事件一句话说明：什么时候触发、能做什么 */
export function eventHint(e: HookEventName): string {
  return e === 'turn.beforeEnd'
    ? t('模型准备结束这一轮时；可以拦住，让它在同一轮里接着做')
    : e === 'tool.before'
      ? t('工具执行前；可以拒绝这次调用，或补一段说明')
      : e === 'tool.after'
        ? t('工具返回后；可以补一段说明')
        : t('压缩上下文、续接之后；可以补一段说明')
}

export const HOOK_EVENTS: HookEventName[] = ['turn.beforeEnd', 'tool.before', 'tool.after', 'context.restored']
