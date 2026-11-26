/**
 * 工具网关（ADR 0084）：套在钩子回答（server/hooks/dispatch.ts 的 onHook）外面，每次工具前 / 工具后都过这里：
 * 认调用（shared/tool-gateway/classify.ts）→ 交给原来的守卫、推送、用户钩子（照旧决定拒绝还是放行）→
 * 推算打开改道会改到哪（shared/tool-gateway/decide.ts）→ 记一条调用记录（./call-log.ts）。
 *
 * 观察模式（默认）：回给 CLI 的永远是原来那一份回答，网关不改一个字。改道模式（第二期）多一步查找接管（./takeover/），
 * 其余能力照旧只推算。网关自己出错一律放行（原回答照样返回），记一条 error。
 * 一次 CLI 调用（一轮）开一个网关：同一轮里的调用才比「本可以并行」，工具前和工具后按工具名 + 输入配对
 */
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { HookAnswer, HookFacts, HookToolScope, HooksSpec } from '../../shared/hooks/index.ts'
import type { HookEventName } from '../../shared/hooks/defs.ts'
import { callSummary, classifyCall, readOnlyCall } from '../../shared/tool-gateway/classify.ts'
import { decide } from '../../shared/tool-gateway/decide.ts'
import { isSerial } from '../../shared/tool-gateway/stats.ts'
import type { CallRecord, GatewayMode, ToolCall } from '../../shared/tool-gateway/types.ts'
import type { ClaimCtx } from '../../shared/capability-router/capabilities.ts'
import { skillPushes } from '../skills/push-ledger.ts'
import { log } from '../log.ts'
import { addCall, callDone, lastInTurn } from './call-log.ts'
import { withSink, type CallSink } from './sink.ts'
import { enforceTakeover, type TakeoverDeps } from './takeover/index.ts'

type OnHook = (event: HookEventName, facts: HookFacts) => Promise<HookAnswer>

export interface GatewayCtx {
  mode: GatewayMode
  task: { id: string; title: string }
  projectId: string
  cliId: string
  spec?: Pick<HooksSpec, 'searchTools'>
  /** 推算用的项目事实（自建工具的程序名）；第一次用到时才取 */
  claimCtx: () => Promise<ClaimCtx>
  /** 不是 mcp__ 写法的 MCP 工具名按已知服务认 */
  resolveMcp?: (name: string, input: Record<string, unknown>) => Promise<{ server: string; tool: string } | undefined>
  /** 改道模式下查找接管要的（ADR 0084 第二期）；没有查找的路时也给，接管自己判断放行 */
  takeover?: TakeoverDeps
}

const INPUT_MAX = 2000
const keyOf = (name: string, input: Record<string, unknown>) => `${name}\u0000${JSON.stringify(input).slice(0, 4000)}`
const round2 = (n: number) => Math.round(n * 100) / 100

export interface Gateway {
  /** 套在原来的钩子回答外面 */
  wrap: (inner: OnHook) => OnHook
  /** 网关开着时工具前、工具后都要装（按 CLI 关掉的事件照旧不装） */
  events: (events: HookEventName[], off: Set<HookEventName>) => HookEventName[]
  /** 所有类别的工具都要进网关：读文件、MCP、面板工具也记 */
  tools: (scope: HookToolScope) => HookToolScope
}

/** 关着时返回 undefined：dispatch 照旧，不多装一个钩子 */
export function openGateway(c: GatewayCtx): Gateway | undefined {
  if (c.mode === 'off') return undefined
  const turn = randomUUID().slice(0, 8)
  // 工具前建的、还没等到工具后的记录：同一个工具名 + 输入按先后配对（同样的调用连发两次也按顺序对上）
  const pending = new Map<string, CallRecord[]>()
  let claim: Promise<ClaimCtx> | undefined

  const classify = async (facts: HookFacts): Promise<ToolCall> => {
    const call = classifyCall(facts.tool!, { cli: c.cliId, spec: c.spec })
    if (call.kind !== 'other' || !c.resolveMcp) return call
    const mcp = await c.resolveMcp(facts.tool!.name, facts.tool!.input)
    return mcp ? { ...call, kind: 'mcp', server: mcp.server, mcpTool: mcp.tool } : call
  }

  const before = async (facts: HookFacts, inner: OnHook): Promise<HookAnswer> => {
    const t0 = performance.now()
    let call: ToolCall | undefined
    let error = ''
    const skillsBefore = skillPushes(c.task.id).length
    try {
      call = await classify(facts)
      // 取不到项目事实（自建工具表读不出来）时按没有算，不让整轮的推算都失败
      claim ??= c.claimCtx().catch(() => ({ customTools: [] }))
    } catch (e) {
      error = (e as Error).message
    }
    const own0 = performance.now() - t0
    const sink: CallSink = { pushes: [] }
    const answer = await withSink(sink, () => inner('tool.before', facts))
    const t2 = performance.now()
    let out = answer
    try {
      const denied = !!answer.deny
      const d = call ? decide(call, await claim!, denied) : { decision: denied ? ('deny' as const) : ('pass' as const) }
      const skills = skillPushes(c.task.id)
        .slice(skillsBefore)
        .map((s) => ({ skill: s.skill, chars: s.chars, tokens: s.tokens }))
      const readOnly = call ? readOnlyCall(call) : false
      const at = Date.now()
      const r: CallRecord = {
        id: randomUUID(),
        at,
        projectId: c.projectId,
        taskId: c.task.id,
        taskTitle: c.task.title,
        turn,
        cli: c.cliId,
        tool: facts.tool!.name,
        kind: call?.kind ?? 'other',
        summary: call ? callSummary(call) : '',
        input: JSON.stringify(facts.tool!.input).slice(0, INPUT_MAX),
        ...(call?.command?.category ? { category: call.command.category } : {}),
        ...(call?.command ? { segments: call.command.segments } : {}),
        ...d,
        ...(denied && sink.denyBy ? { denyBy: sink.denyBy } : {}),
        ...(sink.pushes.length ? { pushes: sink.pushes } : {}),
        ...(skills.length ? { skills } : {}),
        ms: 0,
        ...(readOnly ? { readOnly } : {}),
        ...(error ? { error } : {}),
      }
      if (isSerial(lastInTurn(c.projectId, turn), r)) r.serial = true
      // 改道模式：查找接管（搜索命令、自带的按内容搜）。它自己兜住所有错误，出错照原回答放行
      let tk = 0
      let pendingInput = facts.tool!.input
      if (c.mode === 'enforce' && call && !denied && c.takeover) {
        const t3 = performance.now()
        const x = await enforceTakeover(c.takeover, call, answer)
        tk = performance.now() - t3
        Object.assign(r, x.patch)
        out = x.answer
        pendingInput = x.input ?? pendingInput
      }
      // ms：网关自己（认调用、推算、记录；接管去查、跑原命令的时间在 route.ms 里，不算）；hookMs：整个工具前回答
      r.ms = round2(own0 + performance.now() - t2 - tk)
      r.hookMs = round2(performance.now() - t0)
      // 被拒绝、被代答的不会执行，等不到工具后；改写的按改写后的输入配对（CLI 工具后报的是它真正跑的那份）
      if (!out.deny) {
        const k = keyOf(facts.tool!.name, pendingInput)
        pending.set(k, [...(pending.get(k) ?? []), r])
      }
      addCall(r)
    } catch (e) {
      // 网关出错放行：原来的回答照样返回，调用记录里记一条「网关出错」
      noteError(facts, (e as Error).message, answer)
      return answer
    }
    return out
  }

  const noteError = (facts: HookFacts, message: string, answer: HookAnswer) => {
    log.warn('gateway', '工具网关出错，已放行', { tool: facts.tool?.name, error: message })
    try {
      addCall({
        id: randomUUID(),
        at: Date.now(),
        projectId: c.projectId,
        taskId: c.task.id,
        taskTitle: c.task.title,
        turn,
        cli: c.cliId,
        tool: facts.tool?.name ?? '',
        kind: 'other',
        summary: '',
        input: '',
        decision: answer.deny ? 'deny' : 'pass',
        ms: 0,
        error: message,
      })
    } catch {
      // 连记录都记不了：日志里已经有了
    }
  }

  const after = async (facts: HookFacts, inner: OnHook): Promise<HookAnswer> => {
    const sink: CallSink = { pushes: [] }
    const skillsBefore = skillPushes(c.task.id).length
    const answer = await withSink(sink, () => inner('tool.after', facts))
    try {
      const k = keyOf(facts.tool!.name, facts.tool!.input)
      const list = pending.get(k)
      const r = list?.shift()
      if (list && !list.length) pending.delete(k)
      if (!r) return answer
      r.durMs = Date.now() - r.at
      if (facts.tool?.result?.failed !== undefined) r.failed = facts.tool.result.failed
      // 工具后补的说明（报错推教训、大输出提醒）和推的技能也算这次调用的
      if (sink.pushes.length) r.pushes = [...(r.pushes ?? []), ...sink.pushes]
      const skills = skillPushes(c.task.id).slice(skillsBefore)
      if (skills.length)
        r.skills = [...(r.skills ?? []), ...skills.map((s) => ({ skill: s.skill, chars: s.chars, tokens: s.tokens }))]
      callDone(r)
    } catch (e) {
      log.warn('gateway', '工具网关补记结果出错，已放行', { tool: facts.tool?.name, error: (e as Error).message })
    }
    return answer
  }

  return {
    wrap: (inner) => async (event, facts) => {
      if (!facts.tool || (event !== 'tool.before' && event !== 'tool.after')) return inner(event, facts)
      return event === 'tool.before' ? before(facts, inner) : after(facts, inner)
    },
    events: (events, off) => [
      ...events,
      ...(['tool.before', 'tool.after'] as const).filter((e) => !events.includes(e) && !off.has(e)),
    ],
    tools: (scope) => ({
      'tool.before': [...(scope['tool.before'] ?? []), 'any'],
      'tool.after': [...(scope['tool.after'] ?? []), 'any'],
    }),
  }
}
