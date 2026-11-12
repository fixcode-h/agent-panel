// Orchestra 的计划类工具（从 shared/engine.ts 的 makeOrchestra 拆出来）。
import { kidsOf } from '../child-lookup.ts'
import { pickFlow } from '../flow-run.ts'
import { isChatMode } from '../conv-mode.ts'
import { endTurnCheck, pushTurnEnd } from '../end-turn.ts'
import { requestAction } from '../user-action.ts'
import { activePlan, applyPlan, bindWait, finishPlan, runningStepId } from '../plan.ts'
import type { Orchestra } from '../engine-host.ts'
import type { OrchCtx } from './ctx.ts'

/** 计划类工具：选工作流、列计划、标计划做完 */
export function planTools(oc: OrchCtx) {
  const { host, ctx, task, helper, coordinator } = oc
  return {
    pickWorkflow(key) {
      if (helper || !ctx.planning || !coordinator)
        return {
          ok: false,
          info: '只有项目里的父对话能启动工作流；子对话、子任务和工作流节点都不能，按派给你的事直接做',
        }
      const r = pickFlow(host.workflowCatalog?.() ?? [], key)
      if (r.ok || !key.trim()) return r
      // 用户点名、不在项目可选列表里的工作流（工作流页「在项目里运行」会带上 id）：按 id 认，名字认不出来照旧报
      const w = host.resolveWorkflow?.(key.trim())?.workflow
      if (!w || w.id !== key.trim()) return r
      return { ok: true as const, flow: { workflowId: w.id, workflowName: w.name, kind: w.kind ?? 'change' } }
    },
    async setPlan(input) {
      if (!ctx.chat || helper || !task.projectId) return { ok: false, info: '只有项目里的对话有执行计划' }
      const r = applyPlan(task, input, undefined, host.wrapUp, await kidsOf(host))
      if (r.ok) {
        // 对话自己改了计划：新要求算看过了（见 inputUnhandled）
        const plan = activePlan(task)
        if (plan) plan.agentUpdatedAt = new Date().toISOString()
        // 总结写进这个对话自己的计划（ADR 0041：各写各的，不写进父对话的计划）；最后一步标完成时计划已收起，写在它上面
        const sum = input.summary?.trim()
        const target = plan ?? task.plans?.at(-1)
        if (sum && target) target.summary = sum.slice(0, 8000)
        host.changed(true)
        // 最后一步标完成、计划自动收起却没带总结：提醒补一句，不然这份计划只剩步骤列表，父对话和用户看不到结果
        if (!plan && target?.doneAt && !target.summary)
          return {
            ...r,
            info: `${r.info}\n这份计划还没写总结：用 finish_plan 的 summary 补上（做了什么、结果、遗留）。`,
          }
      }
      return r
    },
    async finishPlan(summary) {
      if (!ctx.chat || helper || !task.projectId) return { ok: false, info: '只有项目里的对话有执行计划' }
      // 计划已自动收起、还没总结：这次只补总结（setPlan 收起时提醒过）；正常结束时总结记在刚结束的这份上
      const closed = !activePlan(task) ? task.plans?.at(-1) : undefined
      if (closed && !closed.summary && summary.trim()) {
        closed.summary = summary.trim().slice(0, 8000)
        host.changed(true)
        return { ok: true, info: '总结记在刚结束的那份计划上了。之后有新内容用 set_plan 开新的计划。' }
      }
      const r = finishPlan(task, summary, undefined, await kidsOf(host))
      const last = task.plans?.at(-1)
      if (r.ok && last && summary.trim()) last.summary = summary.trim().slice(0, 8000)
      if (r.ok) host.changed(true)
      return r
    },
    // 只给对话（不含 Chat 页一问一答、子任务和工作流节点）：结束前钩子只认它交代的结束，不读回复文字
    ...(ctx.chat && !helper && !isChatMode(task)
      ? {
          async endTurn(outcome: string, need: string) {
            // 命令改的文件、插件工具报的改动和验证：只在要记成做完时现取（拍快照有开销）
            const extra = outcome === 'done' ? await host.turnExtra?.().catch(() => undefined) : undefined
            const r = endTurnCheck(task, outcome, need, host.verifyGate, extra)
            if (r.end) pushTurnEnd(task, r.end)
            if (r.end) host.changed(true)
            return { ok: r.ok, info: r.info }
          },
          requestUserAction(input) {
            const r = requestAction(task, input, host.newId())
            if (!r.action) return r
            // 计划里正在做的那一步挂成「等你操作」：交回时按 settleWait 收口
            const step = typeof input?.step === 'string' && input.step.trim() ? input.step : runningStepId(task)
            const wait = step ? bindWait(task, step, { kind: 'user', ref: r.action.id, label: r.action.title }) : ''
            host.changed(true)
            return { ok: true, info: wait && !wait.startsWith('（') ? `${r.info}\n${wait}` : r.info }
          },
        }
      : {}),
  } satisfies Partial<Orchestra>
}
