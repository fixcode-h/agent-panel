/**
 * 技能推送记录（ADR 0083）：每个对话推过哪些技能、各推了多少字和 token、什么时候、因为什么。
 *
 * 用途：同一技能一个对话只推一次（压缩后补推除外）、单个对话推送总量的上限、上下文压缩后按它补推，
 * 以及设置「Agent 工具 → 技能」的「最近推送」和会话栏的「技能」。
 * 只在内存里（task-state 登记，对话删掉时跟着清）：重启后最多再推一次，和情境规则的「推过几次」一样
 */
import { taskMap } from '../runtime/task-state.ts'

export interface SkillPush {
  skill: string
  /** 推进上下文的字数 */
  chars: number
  /** 估算的 token（shared/mcp-catalog/cost.ts 的 estimateTokens） */
  tokens: number
  /** ISO 时间 */
  at: string
  /** 为什么推：条件（edit **\/*.lua）、slash（用户点名）、restored（压缩后补推）、path（超上限只给了路径）…… */
  trigger: string
}

const ledger = taskMap<SkillPush[]>('skills.push-ledger 推过的技能') // 运行时（task-state 登记）

/** 一个对话最多记这么多条：补推、只给路径的也算，够看最近的就行 */
const MAX_PER_TASK = 200

export function recordSkillPush(taskId: string, push: SkillPush): void {
  const list = ledger.get(taskId) ?? []
  list.push(push)
  if (list.length > MAX_PER_TASK) list.splice(0, list.length - MAX_PER_TASK)
  ledger.set(taskId, list)
}

/** 这个对话推过的（按时间先后） */
export function skillPushes(taskId: string): SkillPush[] {
  return [...(ledger.get(taskId) ?? [])]
}

/** 补推（restored）以外推过的技能名：「同一技能只推一次」按它判断 */
export const pushedSkills = (taskId: string) =>
  new Set(skillPushes(taskId).flatMap((p) => (p.trigger === 'restored' ? [] : [p.skill])))

/** 这个对话已经推了多少 token 的正文（补推、只给路径的不算进上限） */
export const pushedTokens = (taskId: string) =>
  skillPushes(taskId).reduce((n, p) => n + (p.trigger === 'restored' || p.trigger.startsWith('path') ? 0 : p.tokens), 0)

/** 所有对话里某个技能最近的推送（新的在前）：设置页「最近推送」用 */
export function recentSkillPushes(skill: string, limit = 10): (SkillPush & { taskId: string })[] {
  const out: (SkillPush & { taskId: string })[] = []
  for (const [taskId, list] of ledger) for (const p of list) if (p.skill === skill) out.push({ ...p, taskId })
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

/** 每个技能一共推过几次（所有对话，补推也算一次） */
export function skillPushCounts(): Map<string, number> {
  const out = new Map<string, number>()
  for (const list of ledger.values()) for (const p of list) out.set(p.skill, (out.get(p.skill) ?? 0) + 1)
  return out
}
