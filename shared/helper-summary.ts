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
  const r = await host.runAgent(call).finally(ran)
  if (!check || !r.ok || call.signal?.aborted || resultOf(step)) return r
  const again = await host.runAgent({ ...call, prompt: RESULT_ASK, fresh: undefined })
  if (!again.ok) return again
  if (!resultOf(step))
    system(host, t('子任务补问了一次还是没有用 submit_result 交结果，做没做完不确定'), step.id, false)
  return { ok: true, text: [r.text, again.text].filter(Boolean).join('\n\n') }
}
