import type { AgentUsage } from '../schema.ts'

/**
 * 把这一轮带的、推过的技能记进会话用量（AgentUsage.skills，会话栏「环境 → 技能」读它）：
 * carried 整个换成这一轮的，pushed 只加没记过的。记了东西返回 true（调用方据此推页面）
 */
export function noteSkillUsage(u: AgentUsage | undefined, patch: { carried?: string[]; pushed?: string[] }): boolean {
  if (!u) return false
  const cur = u.skills ?? { carried: [], pushed: [] }
  const carried = patch.carried ?? cur.carried
  const pushed = [...cur.pushed, ...(patch.pushed ?? []).filter((n) => !cur.pushed.includes(n))]
  if (u.skills && carried.join() === cur.carried.join() && pushed.length === cur.pushed.length) return false
  u.skills = { carried, pushed }
  return true
}
