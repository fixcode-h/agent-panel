/**
 * 「不修了」之后在同一个对话里接着查（用户 2026-11-15 定，改掉 2026-11-07「报告就此关闭、要在父对话重新报」）：
 * 用户点了不修了，回头又在这个对话里让它继续时，以前交报告、改文件、收尾三处都按「报告已关闭」拒绝，
 * 这个对话再也起不了新的报告，只能回父对话重新派。现在只要用户在取消（或删完临时日志）之后亲口说过话，
 * 就重新打开：可以交新一版报告，阶段照常接着算（同意过的根因还算数，方案要重新确认）；
 * 新报告交上来之前不改文件、不收尾。
 * 只看用户有没有在那之后发过消息，不读消息的文字（ADR 0041、0049）
 */
import type { Task } from '../schema.ts'
import type { Diagnosis } from './diagnosis-schema.ts'
import { cleaning } from './phase.ts'

type Reopenable = Pick<Task, 'bug'> & Partial<Pick<Task, 'messages'>>

/** 从哪一刻起算「之后又说了话」：删临时日志的取消从核对完那一刻算（删日志那段话是面板替用户发的），否则从取消那一刻算 */
const sinceOf = (d: Diagnosis) => d.cleanup?.checkedAt ?? d.decidedAt ?? d.at

/** 最新一版是用户取消的、临时日志也处理完了，而且用户在那之后在这个对话里亲口发过消息（不算别的对话转来的、面板推的） */
export function reopenedAfterCancel(task: Reopenable): boolean {
  const d = task.bug?.diagnoses?.at(-1)
  if (d?.status !== 'cancelled' || cleaning(d)) return false
  const since = sinceOf(d)
  return (task.messages ?? []).some((m) => m.role === 'user' && !m.peer && !m.panel && !!m.text.trim() && m.at > since)
}

/** 重新打开后、新报告交上来之前给 Agent 的话（改文件、收尾被拦时）。发给 Agent 的提示词，不翻译 */
export const reopenInfo = (v: number) =>
  `用户在第 ${v} 版点了「不修了」，之后又在这个对话里让你接着做：按流程重新查，先用 submit_diagnosis 交新的报告（用户同意过的根因还算数，可以接着交修复方案；方案要用户重新确认），用户确认了再改文件、再收尾。`
