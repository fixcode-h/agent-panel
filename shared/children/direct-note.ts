/**
 * 父对话执行中，用户在输入框上点了「发给…」把话直接发给某个子对话（分析稿 B1 第 3 条）：
 * 消息记在子对话里，父对话里留这一行，用户回到父对话也看得到那句话去了哪。
 * 这是给人看的记录（panel: note，不算父对话的输入，不交给父对话的 CLI）；父对话那边由计划里挂的等待知道子对话有了新要求。
 * 正式后端（server/tasks/child-messages.ts）和演示后端都用这一份
 */
import { t } from '../i18n.ts'
import type { Task, TaskMessage } from '../schema.ts'

export function directToChildNote(
  child: Pick<Task, 'id' | 'title'>,
  text: string,
  id: string,
  at: string,
): TaskMessage {
  return {
    id,
    role: 'system',
    agentId: '',
    step: '',
    text: t('直接发给「{title}」：{text}', { title: child.title, text: text.trim().slice(0, 4000) }),
    tools: [],
    panel: 'note',
    child: { id: child.id, title: child.title, state: '' },
    at,
  }
}
