/**
 * Agent 用工具交的结论和结果（ADR 0041 第 16 节）：任务、节点、子任务的状态只认这里，**不看回复里写了什么字**。
 * - submit_verdict：验收流程、带条件连线的节点、评审子任务交「通过 / 不通过」和必须处置的意见；
 * - submit_result：子任务交「做完 / 没做完 / 卡住」和总结。
 * 记在交它的那一步（TaskStep.submitted）上，随任务落盘：评审门禁、执行报告重启后也读得到。
 * 以前这些都靠在回复里找「验收结论：通过」「## 总结」这类字眼，没写时还默认按通过 / 做完算，模型漏写一行就被放行了
 */
import { z } from 'zod'

/** 评审、验收列出的一条意见；must：要执行的一方逐条处置（原来的高级 / 中级） */
export const Blocker = z.object({
  id: z.string().default(''),
  text: z.string().default(''),
  must: z.boolean().default(false),
})
export type Blocker = z.infer<typeof Blocker>

export const Submitted = z.object({
  verdict: z.enum(['pass', 'fail']).optional(),
  blockers: z.array(Blocker).default([]),
  state: z.enum(['done', 'unfinished', 'stuck']).optional(),
  summary: z.string().default(''),
  /** 没做完还差什么 / 卡在哪、需要什么 */
  left: z.string().default(''),
  at: z.string().default(''),
})
export type Submitted = z.infer<typeof Submitted>

type WithSubmitted = { submitted?: Submitted }

/** 这一步交的结论；没交返回空串 */
export const verdictOf = (s: WithSubmitted | undefined): 'pass' | 'fail' | '' => s?.submitted?.verdict ?? ''

/** 要执行的一方必须处置的意见编号；没写编号的不在里面（评审没编号时，执行的一方写一条处置就够，同原来的规则） */
export const mustIds = (s: WithSubmitted | undefined): string[] =>
  (s?.submitted?.blockers ?? []).filter((b) => b.must && b.id.trim()).map((b) => b.id.trim())

/** 一组步骤里最后交的那个结论（验收流程里可能有几个节点，按交的时间取最后一个） */
export function latestVerdict<T extends WithSubmitted>(steps: T[]): T | undefined {
  return steps
    .filter((s) => s.submitted?.verdict)
    .sort((a, b) => a.submitted!.at.localeCompare(b.submitted!.at))
    .at(-1)
}

/** 合进这一步已经交的内容（先交结论、后交结果，或者重交都按最后一次为准） */
export function mergeSubmitted(prev: Submitted | undefined, next: Partial<Submitted>, at: string): Submitted {
  return Submitted.parse({
    ...prev,
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)),
    at,
  })
}

/** 补问那一句（发给 Agent，不翻译） */
export const VERDICT_ASK =
  '【面板】你还没有用 submit_verdict 工具交结论。面板只按这个工具判定通过还是不通过，不看回复里写了什么：现在调用它，verdict 写 pass 或 fail，不通过时 blockers 列出必须改的地方。'

/** 把工具交的内容记到交它的那一步上（引擎和测试共用），返回给 Agent 的回执 */
export function submitOn(
  step: WithSubmitted,
  next: Partial<Submitted>,
  changed: () => void,
  now = new Date().toISOString(),
): { ok: true; info: string } {
  step.submitted = mergeSubmitted(step.submitted, next, now)
  changed()
  const what = next.verdict
    ? `结论「${next.verdict === 'pass' ? '通过' : '不通过'}」`
    : next.state
      ? `结果「${{ done: '做完', unfinished: '没做完', stuck: '卡住' }[next.state]}」`
      : '内容'
  return { ok: true, info: `已记下${what}。交完就结束这一轮，不用再在回复里重复写结论。` }
}

/** 验收流程（挂在 parentId 这一步下、第 round 轮）里最后交的结论；没交返回空串 */
export const reviewVerdict = (
  steps: (WithSubmitted & { parentId: string; slot: string; round: number })[],
  parentId: string,
  round: number,
) => verdictOf(latestVerdict(steps.filter((s) => s.parentId === parentId && s.slot === 'review' && s.round === round)))

/**
 * 要交结论的这一轮结束了却没调 submit_verdict：在同一个会话里补问一次，两次的输出合在一起。
 * 补问后还没交，由调用方按「没交结论」处理（不再默认通过）
 */
export async function ensureVerdict<R extends { ok: boolean; text?: string }>(
  r: R,
  step: WithSubmitted,
  ask: (prompt: string) => Promise<R>,
): Promise<R> {
  if (!r.ok || verdictOf(step)) return r
  const again = await ask(VERDICT_ASK)
  return again.ok ? { ...again, text: [r.text, again.text].filter(Boolean).join('\n\n') } : again
}
