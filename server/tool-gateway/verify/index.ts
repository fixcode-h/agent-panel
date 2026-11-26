/**
 * 网关上的「校验」「改动生效」（ADR 0086）：gateway.ts 每次工具前（原来的守卫、钩子回答完之后）调 before，收尾前调 end。
 *
 * 1. 改完自动校验：Agent 改了对得上校验工具 role.paths 的文件先记下（shared/tool-gateway/verify/batch.ts）；
 *    它去做别的事（下一个不是改文件的调用）或要收尾时，面板自己跑一次校验工具查这一批，只把报错随这次工具前回答的
 *    补充说明推回去，没报错什么都不说。超时、工具本身起不来照样写进说明和调用记录，不悄悄吞掉。
 *    观察和改道模式都跑：它只补说明，不改 Agent 的调用（用户 2026-11-26 定：改完 Lua 由面板自己跑检查）。
 * 2. 改道（enforce）时接管：Agent 自己跑 luac 这类（自建工具 role.replaces）→ 面板改用自建工具跑，结果放进拒绝说明
 *    （serve）；UE 编译命令 → 拒绝并说明改用 request_build（redirect）。判定在 shared（verify/plan.ts），这里只执行。
 *    观察模式只记 wouldRoute（gateway.ts 原来就记），情境规则 custom-tool-instead 照旧提醒。
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { BeforeEndDecision, BeforeEndInput, HookAnswer } from '../../../shared/hooks/index.ts'
import type { ClaimCtx } from '../../../shared/capability-router/capabilities.ts'
import { hasPending, newBatch, noteEdits, takeBatch } from '../../../shared/tool-gateway/verify/batch.ts'
import { takeoverPlan } from '../../../shared/tool-gateway/verify/plan.ts'
import { verifyRecord, type VerifyRecordBase } from '../../../shared/tool-gateway/verify/record.ts'
import { serveText, verifyNote, type VerifyOutput } from '../../../shared/tool-gateway/verify/text.ts'
import type { VerifyRun } from '../../../shared/tool-gateway/verify/types.ts'
import type { GatewayDecision, GatewayMode, ToolCall, WouldRoute } from '../../../shared/tool-gateway/types.ts'
import { fileParamOf } from '../../../shared/custom-tools/match.ts'
import { addCall } from '../call-log.ts'
import { log } from '../../log.ts'
import { runVerify, type VerifyTool, type VerifyWhere } from './run.ts'

/** 由 for-call.ts 按项目接好 */
export interface VerifyDeps {
  where: VerifyWhere
  /** 这个项目能用的自建工具（读不进来、被盖住的已去掉）；一轮里只取一次 */
  tools: () => Promise<VerifyTool[]>
  /** 测试用：整次校验的限时（秒） */
  budgetSec?: number
}

export interface VerifyGateCtx {
  mode: GatewayMode
  /** 记录里每行都一样的那几项（id、时间每行另给） */
  base: () => Omit<VerifyRecordBase, 'id' | 'at'>
  deps: VerifyDeps
}

export interface VerifyBeforeIn {
  call: ToolCall
  denied: boolean
  route?: WouldRoute
  claim: ClaimCtx
  answer: HookAnswer
}

export interface VerifyStep {
  answer: HookAnswer
  /** 改道时真的做了的决定（serve / redirect）；没改道不写 */
  decision?: GatewayDecision
  /** 改道代答时跑的那一次 */
  verify?: VerifyRun
  pushes: { id: string; chars: number }[]
}

export interface VerifyGate {
  before: (x: VerifyBeforeIn) => Promise<VerifyStep>
  /** 套在收尾前判断外面：还有没校验的改动就先跑，有报错拦下收尾、把报错交回去 */
  wrapEnd: (
    inner: ((i: BeforeEndInput) => Promise<BeforeEndDecision>) | undefined,
    mark: (reason: string) => void,
  ) => (i: BeforeEndInput) => Promise<BeforeEndDecision>
}

const rel = (root: string, p: string) => {
  const r = path.relative(root, path.resolve(root, p))
  return r.startsWith('..') || path.isAbsolute(r) ? '' : r.replaceAll('\\', '/')
}

export function openVerify(c: VerifyGateCtx): VerifyGate {
  const batch = newBatch()
  let tools: Promise<VerifyTool[]> | undefined
  const all = () => (tools ??= c.deps.tools().catch(() => []))
  const verifiers = async () => (await all()).filter((t) => t.tool.role?.kind === 'verify' && t.tool.effect === 'read')
  const budget = c.deps.budgetSec

  /** 跑这一批，每个工具记一行调用记录；except 是这次改道代答已经接手的工具 */
  const runBatch = async (except = ''): Promise<VerifyOutput[]> => {
    const list = await verifiers()
    const outs: VerifyOutput[] = []
    for (const b of takeBatch(batch)) {
      const t = list.find((x) => x.tool.id === b.tool)
      if (!t || b.tool === except) continue
      const at = Date.now()
      const o = await runVerify(t, b.files, 'auto', c.deps.where, budget)
      addCall(verifyRecord({ ...c.base(), id: randomUUID(), at }, o.run))
      log.info('gateway', '改完自动校验', { tool: t.tool.id, files: b.files.length, outcome: o.run.outcome })
      outs.push(o)
    }
    return outs
  }

  const pushOf = (outs: VerifyOutput[], text: string) =>
    text
      ? outs.filter((o) => o.run.outcome !== 'ok').map((o) => ({ id: `verify:${o.run.tool}`, chars: text.length }))
      : []

  /** 改道代答：Agent 的命令改用自建工具跑；工具起不来时放行原命令（网关出错放行），说明照样补上 */
  const serve = async (x: VerifyBeforeIn, plan: { tool: string; files: string[] }, pending: string[]) => {
    const t = (await all()).find((y) => y.tool.id === plan.tool)
    if (!t) return undefined
    const files = [...new Set([...plan.files, ...pending])]
    const o = await runVerify(t, files, 'replaces', c.deps.where, budget)
    const command = String(x.call.input.command ?? '')
    if (o.run.outcome === 'spawn') return { o, answer: undefined }
    return {
      o,
      answer: {
        deny: true,
        reason: serveText(command, [o], { useWhen: t.tool.useWhen || t.tool.summary, arg: fileParamOf(t.tool) }),
      } satisfies HookAnswer,
    }
  }

  const before = async (x: VerifyBeforeIn): Promise<VerifyStep> => {
    const step: VerifyStep = { answer: x.answer, pushes: [] }
    if (x.denied) return step
    if (x.call.kind === 'edit') {
      const files = x.call.paths.map((p) => rel(c.deps.where.root, p)).filter(Boolean)
      if (files.length)
        noteEdits(
          batch,
          files,
          (await verifiers()).map((t) => ({ id: t.tool.id, paths: t.tool.role!.paths })),
        )
      return step
    }
    const plan = c.mode === 'enforce' ? takeoverPlan(x.call, x.claim, x.route) : undefined
    // 改道代答的那个工具顺手把这一批里归它的文件一起查了：同一批文件不重复跑
    const mine = plan?.kind === 'serve' ? (batch.pending.get(plan.tool) ?? []) : []
    if (plan?.kind === 'serve') batch.pending.delete(plan.tool)
    const outs = hasPending(batch) ? await runBatch() : []
    const note = verifyNote(outs)
    step.pushes = pushOf(outs, note)
    const extra = (a: HookAnswer): HookAnswer =>
      note
        ? {
            ...a,
            ...(a.deny
              ? { reason: `${a.reason ?? ''}\n\n${note}` }
              : { context: [a.context, note].filter(Boolean).join('\n\n') }),
          }
        : a
    if (plan?.kind === 'redirect')
      return { ...step, answer: extra({ deny: true, reason: plan.text }), decision: 'redirect' }
    if (plan?.kind === 'serve') {
      const s = await serve(x, plan, mine)
      if (s?.answer) return { ...step, answer: extra(s.answer), decision: 'serve', verify: s.o.run }
      // 起不来：原命令照跑，把原因补给 Agent，调用记录里这次照样带着那次校验
      if (s) {
        const why = verifyNote([s.o])
        return {
          ...step,
          answer: extra({ ...x.answer, context: [x.answer.context, why].filter(Boolean).join('\n\n') }),
          verify: s.o.run,
        }
      }
    }
    return { ...step, answer: extra(x.answer) }
  }

  const wrapEnd: VerifyGate['wrapEnd'] = (inner, mark) => async (i) => {
    if (hasPending(batch)) {
      const note = verifyNote(await runBatch())
      if (note) {
        mark(note)
        return { block: true, reason: note, why: 'verify-auto' }
      }
    }
    return inner ? inner(i) : { block: false, why: 'verify-auto-ok' }
  }

  return { before, wrapEnd }
}
