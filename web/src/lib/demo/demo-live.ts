/** 演示里正在跑的一轮（模拟执行）：demo-backend 起停，进程面板按它算 CLI 活没活着 */
import { Attachment } from '@shared/schema'

/** held：执行中收下、这一轮结束后接着处理的消息（消息已经记进对话） */
export const live = new Map<
  string,
  { stop: boolean; done?: Promise<unknown>; held?: { text: string; attachments: Attachment[] }[] }
>()
