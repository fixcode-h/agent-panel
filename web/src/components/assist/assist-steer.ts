/**
 * AI 创建 / 分析执行中插话（和对话模式一样随时说）：插进去的那句话把这一轮的回复切成几段，
 * 执行中按段画（回复、用户这句、接着的回复），结束后照样拆成几条对话。
 */
import type { AssistJob, AssistMessage } from '@shared/assist'
import type { TaskMessage } from '@shared/schema'

/** 插话：at 是插进去时这一轮已有几条消息（服务端给的），之后的输出排在这句后面 */
export interface SteerCut {
  at: number
  text: string
}

/** 按插话切开这一轮的消息：段数比插话多一段，最后一段是还在跑（或最后收尾）的那部分 */
export function splitAtCuts(msgs: TaskMessage[], cuts: SteerCut[]): TaskMessage[][] {
  const segs: TaskMessage[][] = []
  let from = 0
  for (const c of cuts) {
    segs.push(msgs.slice(from, Math.max(from, c.at)))
    from = Math.max(from, c.at)
  }
  segs.push(msgs.slice(from))
  return segs
}

type Turn = AssistMessage & { msgs?: TaskMessage[] }

/**
 * 一轮结束：插话前的几段各成一条回复（只有消息流，没有说明文字），插的话成为用户消息；
 * 没被 CLI 取走的插话不算说过，交回 requeue 排到下一轮。最后一段由调用方带上说明、结果和报错
 */
export function turnsFromCuts(
  j: AssistJob,
  cuts: SteerCut[],
): { before: Turn[]; last: TaskMessage[]; requeue: string[] } {
  const unread = new Set(j.unread ?? [])
  const kept = cuts.filter((c) => !unread.has(c.text))
  const segs = splitAtCuts(j.messages ?? [], kept)
  const before = kept.flatMap((c, i): Turn[] => [
    ...(segs[i].length ? [{ role: 'assistant' as const, text: '', msgs: segs[i] }] : []),
    { role: 'user', text: c.text },
  ])
  return { before, last: segs.at(-1) ?? [], requeue: [...unread] }
}

/** 发给 CLI 的对话记录：插话前那几段没有说明文字，不占一条空的回复 */
export function historyOf(turns: Turn[]): AssistMessage[] {
  return turns.filter((x) => x.role === 'user' || x.text.trim()).map(({ role, text }) => ({ role, text }))
}
