/**
 * 改道模式下「校验」「改动生效」两个能力怎么接管（ADR 0086）：网关按能力表推算出 wouldRoute 后，这里定下真的做什么——
 * serve（面板改用自建工具跑，结果放进拒绝说明）还是 redirect（不跑，说明改用哪个工具）。判定和说明都在 shared，
 * 服务端（server/tool-gateway/verify/）只管执行；别的能力（find 的改写 / 代答）是改道模式的通用部分，另做
 */
import { commandFiles, routeToolId } from '../../capability-router/verify-apply.ts'
import type { ClaimCtx } from '../../capability-router/capabilities.ts'
import type { ToolCall, WouldRoute } from '../types.ts'
import { redirectText } from './text.ts'

export type Takeover =
  /** 面板跑 tool，文件取自 Agent 的命令 */
  { kind: 'serve'; tool: string; files: string[] } | { kind: 'redirect'; text: string }

/** 归这两个能力管的改道；不归它们（或没有改道）时返回 undefined */
export function takeoverPlan(call: ToolCall, ctx: ClaimCtx, route: WouldRoute | undefined): Takeover | undefined {
  if (!route || (route.capability !== 'verify' && route.capability !== 'apply')) return undefined
  const command = String(call.input.command ?? '')
  if (route.decision === 'redirect') return { kind: 'redirect', text: redirectText(route.to, ctx, command) }
  const id = routeToolId(route.to)
  const tool = ctx.customTools.find((x) => x.id === id)
  if (route.decision !== 'serve' || !tool) return undefined
  return { kind: 'serve', tool: id, files: tool.fileParam ? commandFiles(command, tool) : [] }
}
