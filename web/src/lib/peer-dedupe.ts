/**
 * 旧数据里子对话的同一份汇报被写了两遍：runner 以前在 CLI 的 result 和「回复完停在等下一句」
 * 两处各标了一次这一轮结束，父对话按不同的 turnDoneAt 当成两轮，各写了一条一模一样的「接收消息」。
 * 新数据在 runner 那一层已经只报一次，这里只收拾旧数据：相邻、同子对话、同标题、同正文、
 * 10 秒内的两条收成一条。不同来源（不同子对话）即使标题和正文一样也不合并。
 */
import type { TaskMessage } from '@shared/schema'
import { peerOfMessage } from '@shared/peer-message'

/** 同一条汇报被写两遍的两次相隔通常不到 1 秒；留宽一些，但远小于同一个子对话两轮汇报的间隔 */
export const SAME_REPORT_MS = 10_000

type Report = { id: string; subject: string; text: string; at: number }

/** 这条消息是不是一份子对话汇报；解析不出时间的按不能合并处理 */
function reportOf(m: TaskMessage): Report | undefined {
  const peer = peerOfMessage(m)
  if (peer?.kind !== 'report') return undefined
  const at = Date.parse(m.at)
  return Number.isFinite(at) ? { id: peer.id, subject: peer.subject, text: m.text, at } : undefined
}

/** 相邻的两条是不是同一个子对话的同一份汇报（去重的唯一判据） */
function sameReport(a: Report, b: Report) {
  return a.id === b.id && a.subject === b.subject && a.text === b.text && Math.abs(a.at - b.at) <= SAME_REPORT_MS
}

export function dedupePeerReports(msgs: TaskMessage[]): TaskMessage[] {
  const out: TaskMessage[] = []
  let prev: Report | undefined
  for (const m of msgs) {
    const report = reportOf(m)
    if (report && prev && sameReport(prev, report)) continue
    // 中间隔了别的消息就不是相邻：同一个子对话真的又报了一轮时照常显示
    prev = report
    out.push(m)
  }
  return out
}
