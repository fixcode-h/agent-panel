/**
 * 节点验收的循环：单执行者节点和逐步节点的每一步共用（以前两处各写一份）。
 *
 * 2026-11-25 一次「写规范」被规范门禁连退 3 轮停下，查出三处面板的问题，这里一起改：
 * - 交回节点的意见只有验收 Agent 回复里的文字，submit_verdict 交的问题清单（blockers）没转过去，
 *   回执还让验收方「不用在回复里重复写结论」，节点只能凭零散的叙述猜要改什么。现在清单原文排在最前面；
 * - 只数轮数：必须改的问题 6 → 3 → 1 明明在收敛，到 3 轮也停。现在只数问题没比上一轮少的轮次，
 *   另按 maxRounds 的 REVIEW_TOTAL_FACTOR 倍兜底，免得一直有进展又一直不过、烧钱；
 * - 到上限直接按出错停，不问用户（用户 2026-11-19 定的原则：门禁冲突时让用户确认后照办）。
 *   现在宿主能弹卡时让用户选「按现状通过」或「再改一轮」，停止任务就停在这里。
 */
import { t } from '../i18n.ts'
import { clip } from '../text.ts'
import { clipToFile } from '../helper-batch.ts'
import { reviewBlockers, reviewVerdict, type Blocker } from '../submitted.ts'
import type { TaskStep } from '../schema.ts'
import type { AgentResult, EngineHost, Fail } from './host.ts'
import { overBudget } from './budget.ts'

/** 一直有进展（问题在变少）也最多验收 maxRounds 的这么多倍轮，到了照样问用户 */
export const REVIEW_TOTAL_FACTOR = 2

type Ran = { ok: true; output: string } | Fail

export interface ReviewLoop {
  host: EngineHost
  /** 被验收、记 rounds / verdict / reviews 的那一步 */
  target: TaskStep
  /** 长意见存文件时挂在哪一步下 */
  handoff: Pick<TaskStep, 'id' | 'title'>
  maxRounds: number
  /** 取下一轮的轮次号（用户退回后重新验收，轮次接着编号） */
  nextRound: () => number
  /** 跑一轮验收流程 */
  run: (round: number) => Promise<Ran>
  /** 带着意见返工：agentText 给 Agent 节点，flowText 给流程节点 */
  rework: (agentText: string, flowText: string) => Promise<AgentResult>
  /** 返工后的新结果 */
  done: (text: string) => void
  /** 写一条系统消息（引擎的 system，避免循环引用） */
  note: (text: string, step: string) => void
}

/** 一条意见一行：编号、内容；没有编号的只写内容 */
const line = (b: Blocker) => `- ${b.id ? `${b.id}：` : ''}${b.text || '（没写内容）'}`

/**
 * 交回节点的意见：先列 submit_verdict 交的清单（必须改 / 建议分开），再附验收过程的说明。
 * 没交清单的旧验收流程只有说明，和以前一样
 */
export function reviewFeedback(blockers: Blocker[], output: string): string {
  const must = blockers.filter((b) => b.must)
  const rest = blockers.filter((b) => !b.must)
  const parts = [
    must.length ? `### 必须改（${must.length} 条，逐条处置）\n${must.map(line).join('\n')}` : '',
    rest.length ? `### 建议（${rest.length} 条，能改就改，不改写明理由）\n${rest.map(line).join('\n')}` : '',
    output.trim() ? `### 验收过程的说明\n${output.trim()}` : '',
  ].filter(Boolean)
  return parts.join('\n\n') || '（验收没有写意见）'
}

/** 衡量这一轮还剩多少问题：有必须改的只数必须改的，没标必须的按全部意见数 */
const sizeOf = (blockers: Blocker[]) => blockers.filter((b) => b.must).length || blockers.length

/**
 * 上一次执行最后一轮验收没通过（到上限停下、用户在卡片上停止）时的意见：重新执行这个节点时带上，
 * 不然重跑拿到的是原始需求，最后一轮挑出的问题没人知道（这次的 F17 就是这样丢的）。
 * 重跑开始时会清掉验收子步骤，所以要在清之前取
 */
export function carriedFeedback(steps: TaskStep[], step: TaskStep): string {
  if (step.verdict !== 'fail') return ''
  const rounds = steps.filter((s) => s.parentId === step.id && s.slot === 'review').map((s) => s.round)
  if (!rounds.length) return ''
  const round = Math.max(...rounds)
  if (reviewVerdict(steps, step.id, round) !== 'fail') return ''
  const output = steps
    .filter((s) => s.parentId === step.id && s.slot === 'review' && s.round === round)
    .map((s) => s.output)
    .filter(Boolean)
    .join('\n\n')
  return `上一次执行最后一轮验收（第 ${round} 轮）没有通过，这次重新执行要先处置这些意见：\n\n${reviewFeedback(reviewBlockers(steps, step.id, round), clip(output, 6000))}\n\n请在已经做好的结果上按意见修改本节点「${step.title}」，完成后同样简要总结。`
}

/** 验收不通过就带着意见返工，直到通过、用户放行或停下；通过返回 null */
export async function runReviewLoop(o: ReviewLoop): Promise<Fail | null> {
  const { host, target } = o
  let stall = 0
  let total = 0
  let prev: number | undefined
  // 用户选了「再改一轮」：改完再不过就再问一次
  let askNext = false
  for (;;) {
    const round = o.nextRound()
    const rv = await o.run(round)
    if (!rv.ok)
      return {
        ...rv,
        error: rv.stopped
          ? rv.error
          : t('「{title}」的验收流程失败：{error}', { title: target.title, error: rv.error }),
      }
    // 结论只认验收流程里用 submit_verdict 交的（ADR 0041 第 16 节）；没交不算通过，按出错停下给用户看
    const verdict = reviewVerdict(host.task.steps, target.id, round)
    target.rounds = round
    if (!verdict)
      return {
        ok: false,
        error: t('「{title}」的验收流程没有用 submit_verdict 交结论，不能算通过', { title: target.title }),
      }
    target.verdict = verdict
    host.changed(true)
    if (verdict !== 'fail') return null
    // 不通过、要带着意见重做这一轮：单独累加，重新执行节点时 rounds 会清零，从 rounds 反推会少算
    target.reviews = (target.reviews ?? 0) + 1
    if (host.halted) return { ok: false, halted: true, error: '' }
    const blockers = reviewBlockers(host.task.steps, target.id, round)
    const size = sizeOf(blockers)
    if (prev === undefined || size >= prev) stall++
    prev = size
    total++
    const feedback = reviewFeedback(blockers, rv.output)
    if (askNext || stall >= o.maxRounds || total >= o.maxRounds * REVIEW_TOTAL_FACTOR) {
      const pick = await atLimit(o, round, feedback)
      if (pick !== 'again') return pick
      askNext = true
    } else
      o.note(
        t('「{title}」第 {round} 轮验收未通过，已把意见交回节点继续完善。', { title: target.title, round }),
        target.id,
      )
    // 预算到了就暂停，免得验收来回循环一直烧钱
    const again = overBudget(host)
    if (again) return { ok: false, stopped: true, budget: true, error: again }
    const fb = await o.rework(
      `验收没有通过（第 ${round} 轮）。验收意见：\n\n${feedback}\n\n请逐条处置「必须改」的问题，改完顺带检查同一类问题别处还有没有，一次改全；然后继续完善本节点「${target.title}」的工作，完成后同样简要总结。`,
      `上一轮的结果没有通过验收，意见：\n\n${feedback}`,
    )
    if (!fb.ok) return fb
    o.done(fb.text)
  }
}

/** 到上限：能弹卡就问用户；用户放行返回 null，再改一轮返回 'again'，其余返回失败 */
async function atLimit(o: ReviewLoop, round: number, feedback: string): Promise<Fail | null | 'again'> {
  const { host, target } = o
  if (host.reviewLimit) {
    const pick = await host.reviewLimit(target, { round, feedback })
    if (!pick) return { ok: false, stopped: true, error: t('已停止') }
    if (pick === 'again') {
      o.note(t('「{title}」第 {round} 轮验收未通过，你选了再改一轮。', { title: target.title, round }), target.id)
      return 'again'
    }
    // 用户放行：记成通过往下走，消息里留一行，事后看得出是谁放行的
    target.verdict = 'pass'
    host.changed(true)
    o.note(
      t('「{title}」第 {round} 轮验收仍未通过，你选了按现状通过，继续往下执行。', { title: target.title, round }),
      target.id,
    )
    return null
  }
  return {
    ok: false,
    kind: 'review',
    error: t('「{title}」验收 {round} 轮仍未通过。最后一轮的意见：\n{feedback}', {
      title: target.title,
      round,
      feedback: await clipToFile(host.saveHandoff, o.handoff, feedback, 1500, '先读完。'),
    }),
  }
}
