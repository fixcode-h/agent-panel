import type { Task } from '@shared/schema'

/**
 * 只取到最后一段消息的长对话（打开时服务端按 OPEN_MESSAGE_LIMIT 截断）要换成列表摘要时，用来算摘要的那份任务：
 * 这一段里不一定有第一条用户消息，也不一定有最近那条（一条要求后面跟着几百条输出时）。
 * 只用列表里那份摘要的消息重算的话，摘要只留了第一条用户消息、算出来的「最近发言时间」退回到最早那条，
 * 侧栏按它排序，这个对话会往下掉一截、等列表刷新又跳回来（用户报的「来回点击排序闪一下」）。
 * 所以带上列表里的 askedAt，再并上这一段里的用户消息（打开期间刚发的那条也算）
 */
export function windowedForSummary<T extends Task>(page: T, listed: Task | undefined): T {
  return {
    ...page,
    askedAt: listed?.askedAt,
    messages: [...(listed?.messages ?? []), ...page.messages.filter((m) => m.role === 'user')],
  }
}
