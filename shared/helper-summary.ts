/**
 * 子任务交结果（ADR 0041 第 16 节）：子任务做完、没做完、做不下去，最后都用 submit_result 工具交
 * （state + summary + left），结果记在子任务自己那一步（TaskStep.submitted）上。
 * **不看回复里写了什么字**（原来按「## 总结」「状态：」判，用户 2026-11-02 定：绝不按输出内容判状态）。
 * 这一轮结束了还没交：在同一个会话里补问一次；还没交，照常交回并写一行警告，按「没交结果」处理。
 * 子任务这一层不反复推：没做完、卡住的由派它的对话按自己的计划处理（计划里等它的那一步退回进行中，见 engine 的 settleHelperWaits）
 */
import type { AgentCall, AgentResult, EngineHost } from './engine.ts'
import type { TaskStep } from './schema.ts'
import { t } from './i18n.ts'
import { CHILD_RESTART_MAX } from './stuck-child.ts'

/** 补问那一句（发给 Agent，不翻译） */
export const RESULT_ASK =
  '【面板】你还没有用 submit_result 工具交结果。面板只按这个工具判断子任务做完没有，不看回复里写了什么：现在调用它，state 写 done（做完）、unfinished（没做完）或 stuck（做不下去），summary 写结论和关键文件，没做完或卡住时 left 写还差什么、卡在哪。'

/** 这一步交的结果；没交返回 undefined */
export const resultOf = (step: Pick<TaskStep, 'submitted'>) => step.submitted?.state

/** 交回派它的对话时这一步的状态说明（结果文字之前的一行） */
export function resultLine(step: Pick<TaskStep, 'submitted'>): string {
  const s = step.submitted
  if (!s?.state) return '（没有用 submit_result 交结果，做没做完不确定）'
  if (s.state === 'done') return '（交了结果：做完）'
  return `（交了结果：${s.state === 'stuck' ? '卡住' : '没做完'}${s.left ? `：${s.left}` : ''}）`
}

/**
 * 跑子任务的一轮；没交结果就在同一个会话里补问一次，两次的输出合在一起交回。
 * 被单独终止的不补问。system 由 engine 传进来，免得两个模块互相引用
 */
export async function runWithSummary(
  host: EngineHost,
  step: TaskStep,
  call: AgentCall,
  ran: () => void,
  system: (host: EngineHost, text: string, step: string, error: boolean) => void,
  /** false：评审这类用 submit_verdict 交结论的子任务，不要求 submit_result */
  check = true,
): Promise<AgentResult> {
  call = { ...call, stallRetry: true }
  const r = await runStalled(host, step, call, system).finally(ran)
  if (!check || !r.ok || call.signal?.aborted || resultOf(step)) return r
  const again = await runStalled(host, step, { ...call, prompt: RESULT_ASK, fresh: undefined }, system)
  if (!again.ok) return again
  if (!resultOf(step))
    system(host, t('子任务补问了一次还是没有用 submit_result 交结果，做没做完不确定'), step.id, false)
  return { ok: true, text: [r.text, again.text].filter(Boolean).join('\n\n') }
}

/** 卡住重试时交给子任务的那句（发给 Agent，不翻译） */
export const stallRetryAsk = (error: string) =>
  `【面板】你上一次卡住了：${error}\n面板停掉了那次调用，接回这个会话。先看看已经做了哪些，从中断的地方接着做，已经做完的不用重做；做完照样用 submit_result 交结果。`

/**
 * 跑一次子任务调用；CLI 卡住被 runner 停掉（stalled，见 runner 的「没有响应」检测）就接回会话重试，
 * 最多 CHILD_RESTART_MAX 次，和卡住的子对话同一个上限。每次重试都在子任务里写一行说明（不悄悄重试）；
 * 用完次数按失败交回派它的对话，由它按计划处理，不让父对话一直干等（用户 2026-11-03 报的子任务卡死）
 */
export async function runStalled(
  host: EngineHost,
  step: TaskStep,
  call: AgentCall,
  system: (host: EngineHost, text: string, step: string, error: boolean) => void,
): Promise<AgentResult> {
  let r = await host.runAgent(call)
  for (let n = 1; !r.ok && r.stalled && n <= CHILD_RESTART_MAX; n++) {
    if (call.signal?.aborted || host.halted) return r
    system(
      host,
      t('子任务的 CLI 卡住了，面板停掉它、接回会话重试（第 {n} 次）：{error}', { n, error: r.error }),
      step.id,
      false,
    )
    r = await host.runAgent({ ...call, prompt: stallRetryAsk(r.error), fresh: undefined })
  }
  if (r.ok || !r.stalled) return r
  return {
    ...r,
    error: t('子任务的 CLI 连续卡住，面板接回会话重试了 {n} 次还是没有输出：{error}', {
      n: CHILD_RESTART_MAX,
      error: r.error,
    }),
  }
}
