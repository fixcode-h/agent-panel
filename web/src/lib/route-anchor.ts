/**
 * 分诊卡插在 AI 回复里哪个位置：发起它的那次派单调用所在的消息后面。
 * 分诊记录（TaskRoute）只记了出自哪条用户消息和时间，派子任务的还记得派出的步骤 id；
 * 这里按这些对回消息流里的一条消息，界面把卡片接在那条消息后面，并且不收进折叠（用户 2026-11-05 要求）
 */
import type { TaskMessage, TaskRoute } from '@shared/schema'
import { MAIN_STEP } from '@shared/flow'

/** 能挂分诊卡的消息：父对话自己的 AI 回复（不含子任务的输出），以及记着派出子任务的那条 */
const host = (m: TaskMessage) => (m.role === 'agent' && (!m.step || m.step.endsWith(MAIN_STEP))) || !!m.spawned?.length

/**
 * 每条分诊挂在哪条消息后面（消息 id → 分诊，按记录顺序）。
 * - 派子任务：派出的步骤 id 记在那条消息的 spawned 里，直接对上
 * - 其余（新开 / 交回子对话、就地微改动）：派单调用发生时最后一条已经出现的回复。
 *   一条消息里工具调用在文字前面，调用之后的话会另起一条，所以「分诊时刻之前最后出现的那条」就是发起调用的那条
 * 对不上的（旧数据、出自的用户消息后面还没有回复）挂在出自的用户消息上，界面在用户消息下面画
 */
export function routeAnchors(messages: TaskMessage[], routes: TaskRoute[] | undefined): Map<string, TaskRoute[]> {
  const out = new Map<string, TaskRoute[]>()
  if (!routes?.length) return out
  const index = new Map(messages.map((m, i) => [m.id, i]))
  const put = (id: string, r: TaskRoute) => {
    const list = out.get(id)
    if (list) list.push(r)
    else out.set(id, [r])
  }
  for (const r of routes) {
    const from = r.messageId ? (index.get(r.messageId) ?? -1) : -1
    const spawned =
      r.target === 'subtask'
        ? messages.find((m, i) => i > from && m.spawned?.some((id) => r.refs.includes(id)))
        : undefined
    if (spawned) {
      put(spawned.id, r)
      continue
    }
    const at = Date.parse(r.at)
    let anchor: TaskMessage | undefined
    for (let i = from + 1; i < messages.length; i++) {
      const m = messages[i]
      // 出自的那条之后又来了一条用户自己发的消息：已经是下一轮了，不再往后找
      if (m.role === 'user' && !m.peer) break
      const t = Date.parse(m.at)
      if (Number.isFinite(at) && Number.isFinite(t) && t > at) break
      if (host(m)) anchor = m
    }
    if (anchor) put(anchor.id, r)
    else if (r.messageId) put(r.messageId, r)
  }
  return out
}

/** 两份挂载位置是否一样（同样的消息挂着同样的分诊）：一样时沿用旧的引用，消息列表不用重画 */
export function sameAnchors(a: Map<string, TaskRoute[]>, b: Map<string, TaskRoute[]>) {
  if (a.size !== b.size) return false
  for (const [id, list] of a) {
    const other = b.get(id)
    if (!other || other.length !== list.length || other.some((r, i) => r.id !== list[i].id)) return false
  }
  return true
}
