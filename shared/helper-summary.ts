/**
 * 子任务按最后的总结判定做完（用户 2026-11-02 定的）：子任务不列计划、也没有总结卡，
 * 做完要交一段以 SUMMARY_HEAD 开头的总结。这一轮结束时最后一条回复里没有这段总结
 * （比如说完「继续读某某文件」就结束了这一轮），就在同一个会话里推它一次：没做完接着做，做完了把总结写出来。
 * 推过还是没有总结，照常交回，同时留一行警告给用户看，不来回推。
 * 只看格式（总结那一行标题），不按「已 / 完成」这类字眼猜它做没做完。
 */
import type { AgentCall, AgentResult, EngineHost } from './engine.ts'
import type { Task, TaskStep } from './schema.ts'
import { t } from './i18n.ts'

/** 子任务总结的标题行；写进发给 Agent 的提示词，不翻译 */
export const SUMMARY_HEAD = '## 总结'
const HEAD_LINE = /^#{1,4}\s*(总结|summary)\s*[:：]?\s*$/im

/** 推它补总结的那句话（发给 Agent，不翻译） */
export const SUMMARY_NUDGE = `【面板】这个子任务这一轮结束了，但还没交最后的总结（以「${SUMMARY_HEAD}」开头的那一段）。面板按最后的总结判断子任务做完没有：还没做完就接着做完；已经做完了，就把总结写出来交回。`

/**
 * 这一轮最后一条回复里没有总结。看不到这一轮的对话记录（单测里不写消息的假执行）时不判，返回 false
 */
export function missingSummary(task: Task, step: TaskStep): boolean {
  const since = step.startedAt ?? ''
  const last = task.messages.filter((m) => m.step === step.id && m.role === 'agent' && m.at >= since).at(-1)
  return !!last && !HEAD_LINE.test(last.text)
}

/**
 * 跑子任务的一轮；做完了却没交总结就在同一个会话里推一次，两次的输出合在一起交回。
 * 被单独终止的不推（signal 已经触发）。system 由 engine 传进来，免得两个模块互相引用
 */
export async function runWithSummary(
  host: EngineHost,
  step: TaskStep,
  call: AgentCall,
  ran: () => void,
  system: (host: EngineHost, text: string, step: string, error: boolean) => void,
  /** false：评审这类有自己交卷格式（验收结论）的子任务，按那个判定，不看总结 */
  check = true,
): Promise<AgentResult> {
  const r = await host.runAgent(call).finally(ran)
  if (!check || !r.ok || call.signal?.aborted || !missingSummary(host.task, step)) return r
  const again = await host.runAgent({ ...call, prompt: SUMMARY_NUDGE, fresh: undefined })
  if (!again.ok) return again
  if (missingSummary(host.task, step))
    system(host, t('子任务推了一次还是没交最后的总结，交回的结果可能没做完'), step.id, false)
  return { ok: true, text: [r.text, again.text].filter(Boolean).join('\n\n') }
}
