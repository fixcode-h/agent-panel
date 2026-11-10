import { isChatMode } from '@shared/conv-mode'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'

/**
 * 输入框占位里写明这是哪种模式（分析稿 U10）：以前只有左上角三个小图标分得出 Agent 和 Chat。
 * 项目里（Agent 模式）是交一件事让它一路做完，Chat 页是一问一答；插件页、不属于这两种的照旧写原来那句
 */

/** 新建对话的输入框：首页（项目里）和 Chat 页 */
export function newTaskHint(o: { standalone?: boolean; plugin?: string }) {
  if (o.plugin) return t('想问什么，或者让它做什么')
  return o.standalone ? t('想问什么？这里问一句答一句') : t('要做什么？交给它一路做完')
}

/** 对话页没在执行、也没在等什么时的输入框占位 */
export function continueHint(task: Pick<Task, 'mode' | 'projectId' | 'parentTaskId' | 'plugin'>) {
  if (task.plugin) return t('继续输入要求')
  if (isChatMode(task)) return t('接着问，这里问一句答一句')
  return task.projectId ? t('继续输入要求，交给它一路做完') : t('继续输入要求')
}
