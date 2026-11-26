/**
 * 网关的决定（设计稿 5.2）。观察模式下真实决定只取现有逻辑的结果：守卫、用户钩子、拦截档教训拒绝了就是 deny，其余 pass；
 * 另外按能力表（shared/capability-router/capabilities.ts）推算打开改道会改到哪（wouldRoute），只记录不执行。
 * 被拒绝的调用不会执行，也就谈不上改道：deny 时不算 wouldRoute
 */
import { claimOf, type ClaimCtx } from '../capability-router/capabilities.ts'
import type { CapabilityId } from '../capability-router/types.ts'
import type { GatewayDecision, ToolCall, WouldRoute } from './types.ts'

export interface Decision {
  decision: GatewayDecision
  capability?: CapabilityId
  wouldRoute?: WouldRoute
}

export function decide(call: ToolCall, ctx: ClaimCtx, denied: boolean): Decision {
  const hit = claimOf(call, ctx)
  const base: Decision = { decision: denied ? 'deny' : 'pass', ...(hit ? { capability: hit.capability } : {}) }
  if (denied || !hit?.claim.route) return base
  return {
    ...base,
    wouldRoute: {
      capability: hit.capability,
      decision: hit.claim.route.decision,
      to: hit.claim.route.to,
      by: hit.claim.by,
    },
  }
}
