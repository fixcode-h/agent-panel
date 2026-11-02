/**
 * 子任务按最后的总结判定做完（用户 2026-11-02 定的；ADR 0041 第 15.6 节）：子任务不列计划、也没有总结卡，
 * 做完要交一段以 SUMMARY_HEAD 开头的总结，第一行写状态（STATE_LINE：完成 / 卡住）。
 * 这一轮结束时没交总结（比如说完「继续读某某文件」就结束了），或者总结写的是「未完成」，就在同一个会话里推它接着做
 * （自驱，最多 HELPER_DRIVE_MAX 次）；写「卡住」的不推，原样交回派它的一方，由它改要求或换人。
 * 推满了还没做完，照常交回，同时留一行警告给用户看。
 * 只认总结标题和状态行这两处约定格式，不按「已 / 完成」这类字眼猜它做没做完；旧格式只有标题没有状态行的，按做完算
 */
import type { AgentCall, AgentResult, EngineHost } from './engine.ts'
import type { Task, TaskStep } from './schema.ts'
import { t } from './i18n.ts'

/** 子任务总结的标题行；写进发给 Agent 的提示词，不翻译 */
export const SUMMARY_HEAD = '## 总结'
/** 总结第一行的状态写法（发给 Agent，不翻译） */
export const STATE_LINE = '状态：完成'
const HEAD_LINE = /^#{1,4}\s*(总结|summary)\s*[:：]?\s*$/im
const STATE_RE =
  /^[\s>*-]*(?:状态|state|status)\s*[:：]\s*(完成|未完成|卡住|done|unfinished|stuck)\s*(?:[:：，,]\s*(.*))?$/im

/** 同一个子任务一次派单里，面板最多推它接着做几次（和对话同一进度的上限一样） */
export const HELPER_DRIVE_MAX = 3

/** 推它补总结的那句话（发给 Agent，不翻译） */
export const SUMMARY_NUDGE = `【面板】这个子任务这一轮结束了，但还没交最后的总结（以「${SUMMARY_HEAD}」开头的那一段）。面板按最后的总结判断子任务做完没有：还没做完就直接调用工具接着做完；已经做完了，就把总结写出来交回，第一行写「${STATE_LINE}」。`

/** 总结写了「未完成」时推它接着做的那句话 */
const unfinishedNudge = (note: string) =>
  `【面板】你的总结写的是「未完成」${note ? `（${note}）` : ''}。接着做完再交总结，直接调用工具去做，不用先说明；确实做不下去就把状态写成「卡住：卡在哪、需要什么」。`

export type HelperState = { state: 'done' | 'stuck' | 'unfinished' | 'missing'; note: string }

/**
 * 这一轮最后一条回复的完成状态。看不到这一轮的对话记录（单测里不写消息的假执行）时不判，返回 undefined
 */
export function helperState(task: Task, step: TaskStep): HelperState | undefined {
  const since = step.startedAt ?? ''
  const last = task.messages.filter((m) => m.step === step.id && m.role === 'agent' && m.at >= since).at(-1)
  if (!last) return undefined
  const head = HEAD_LINE.exec(last.text)
  if (!head) return { state: 'missing', note: '' }
  const m = STATE_RE.exec(last.text.slice(head.index))
  if (!m) return { state: 'done', note: '' }
  const word = m[1].toLowerCase()
  const state =
    word === '卡住' || word === 'stuck' ? 'stuck' : word === '未完成' || word === 'unfinished' ? 'unfinished' : 'done'
  return { state, note: (m[2] ?? '').trim().slice(0, 200) }
}

/** 这一轮最后一条回复里没有总结（兼容旧调用方） */
export const missingSummary = (task: Task, step: TaskStep) => helperState(task, step)?.state === 'missing'

/**
 * 跑子任务的一轮；没交总结、或总结写的是「未完成」，就在同一个会话里推它接着做（最多 HELPER_DRIVE_MAX 次），
 * 几次的输出合在一起交回。被单独终止的不推（signal 已经触发）。system 由 engine 传进来，免得两个模块互相引用
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
  if (!check || !r.ok) return r
  const texts = [r.text]
  let st = helperState(host.task, step)
  for (let n = 0; n < HELPER_DRIVE_MAX && st && (st.state === 'missing' || st.state === 'unfinished'); n++) {
    if (call.signal?.aborted) return r
    const prompt = st.state === 'missing' ? SUMMARY_NUDGE : unfinishedNudge(st.note)
    const again = await host.runAgent({ ...call, prompt, fresh: undefined })
    if (!again.ok) return again
    texts.push(again.text)
    st = helperState(host.task, step)
  }
  if (st?.state === 'missing' || st?.state === 'unfinished')
    system(
      host,
      t('子任务推了 {n} 次还是没做完（{why}），交回的结果可能不完整', {
        n: HELPER_DRIVE_MAX,
        why: st.state === 'missing' ? t('没交最后的总结') : t('总结写的是未完成'),
      }),
      step.id,
      false,
    )
  return { ok: true, text: texts.filter(Boolean).join('\n\n') }
}
