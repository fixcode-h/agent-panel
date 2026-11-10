/** 给对话发消息、交回「等你操作」。从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入 */
import type { Attachment, Task } from '@shared/schema'
import { json, request } from './api'

export const messagesApi = {
  /**
   * 发一条消息。messageId：页面已经按这个 id 在本地插进对话了（待认领），服务端沿用它，
   * 推送和响应到达时按 id 换成真实的一份，不会出现两条。
   * userAction：这条是交回「等你操作」的结果（输入框挂着「交回给」时），服务端收口那件事
   */
  sendMessage: (
    id: string,
    text: string,
    attachments: Attachment[] = [],
    interrupt = false,
    messageId = '',
    userAction = '',
  ) =>
    request<Task>(
      `/tasks/${id}/messages`,
      json('POST', {
        text,
        attachments,
        interrupt,
        ...(messageId ? { messageId } : {}),
        ...(userAction ? { userAction } : {}),
      }),
    ),
  /** 等你操作：完成了（没有要交回的）/ 做不了（写原因）/ 跳过；交回内容走 sendMessage */
  settleUserAction: (id: string, actionId: string, how: 'done' | 'cannot' | 'skipped', reason = '') =>
    request<Task>(`/tasks/${id}/user-action/${actionId}`, json('POST', { how, reason })),
}
