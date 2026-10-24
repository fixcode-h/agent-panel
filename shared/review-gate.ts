import type { PlanStep, TaskStep } from './schema.ts'
import { parseVerdict } from './engine.ts'

/**
 * 评审门禁：子对话合回父对话分支之前，必须
 * 1) 计划里有一条标了 review 的评审步骤（执行角色会把它单独写进计划，用户能在计划面板上看到）；
 * 2) 那一步已经完成（派评审时标等待中，拿回结论后标完成）；
 * 3) 评审子任务真的跑过，并且最近一次的结论是通过。
 * 前两条读计划（PlanStep.review），第三条读 steps 里 slot 为 sub 的评审子任务——
 * 评审就是一次普通的 spawn_agents，结论写在它的输出里：不另存状态，也不另造一套和现有工具并行的机制。
 * 结论的识别和验收节点共用 engine.ts 的 parseVerdict（「验收结论：通过 / 不通过」，英文 Verdict: pass / fail）。
 */
export type ReviewGate = { ok: true } | { ok: false; info: string }

/** 怎么派评审：拒绝时连这段一起给子对话，它照着做就能过 */
export const REVIEW_TIP = [
  '收尾前先派一次「评审」（spawn_agents 的 agent 写「评审」），并在计划里单独列出「评审本次改动」这一步（标 review: true）：',
  '- 派评审时把这一步标成等待中，拿回结论后标完成；',
  '- instructions 里写清：这次的需求和验收标准、父对话划的范围、要它看的基线（git diff 基线..HEAD，或工作区改动）、已经跑过的快速检查结果；',
  '- 要它**第一行**先单独写「验收结论：通过」或「验收结论：不通过」，再按 🛑 / 💭 / 💅 分级列意见：子任务输出太长时面板只留开头，结论写在末尾会被截掉，门禁就读不到。',
  '拿回意见后按 🛑 改完（这一步也是计划里的独立步骤），再派一次评审复看（同样作为独立步骤、同样标 review）；复看通过后跑完整测试，最后再调用 submit_merge。',
].join('\n')

/** 计划里还没有标 review 的步骤 */
const NO_STEP = `没有请求收尾：计划里缺少评审步骤。执行角色收尾时要把评审单独写进计划（set_plan 里一条主步骤，标题写清是评审，并标 review: true）——放在别的步骤的子步骤里不算：派评审时标等待中，拿回结论后标完成，计划面板上能看到这一步才算数。`

export function reviewGate(
  steps: TaskStep[],
  isReviewer: (agentId: string) => boolean,
  planSteps: PlanStep[] = [],
): ReviewGate {
  // 不止一步时要全部完成：只看第一条会把「第一份已完成、第二份还在等」当成做完了
  const planReviews = planSteps.filter((s) => s.review)
  if (!planReviews.length) return { ok: false, info: `${NO_STEP}\n\n${REVIEW_TIP}` }
  const open = planReviews.find((s) => s.status !== 'done')
  if (open)
    return {
      ok: false,
      info: `没有请求收尾：计划里的评审步骤「${open.title}」还没完成（现在是「${open.status}」）。等评审给出结论、按 🛑 改完再复看，把这一步标完成之后才调用 submit_merge。`,
    }
  const reviews = steps.filter((s) => s.slot === 'sub' && !!s.agentId && isReviewer(s.agentId))
  if (!reviews.length)
    return { ok: false, info: `没有请求收尾：计划里有评审步骤，但还没有真的派过「评审」。${REVIEW_TIP}` }
  const last = reviews.at(-1)!
  if (last.status !== 'done') {
    const why = last.status === 'running' || last.status === 'pending' ? '还没跑完' : '没有正常结束'
    return {
      ok: false,
      info: `没有请求收尾：最近一次评审「${last.title}」${why}。等它给出结论再调用 submit_merge；它失败或被你停掉时重新派一次。`,
    }
  }
  const verdict = reviewVerdict(last.output)
  if (verdict === 'pass') return { ok: true }
  if (verdict === 'fail')
    return {
      ok: false,
      info: `没有请求收尾：最近一次评审的结论是「不通过」。按 🛑 逐条改完，再派一次「评审」复看，通过之后才调用 submit_merge。`,
    }
  return {
    ok: false,
    info: `没有请求收尾：最近一次评审「${last.title}」没有写验收结论。让它第一行单独写「验收结论：通过」或「验收结论：不通过」（回复用英文时写「Verdict: pass」或「Verdict: fail」），再调用 submit_merge。`,
  }
}

/**
 * 读评审的结论：**先看第一行**（约定把结论写在最前面，输出太长时不会被截掉），首行没有结论再退回全文最后一条。
 * 不直接用 parseVerdict（它取全文最后一条，验收节点的语义要保留）：复看时正文里常见「上一轮的『验收结论：不通过』已改掉」，
 * 取最后一条会把已通过的复看判成不通过。
 */
function reviewVerdict(output: string): 'pass' | 'fail' | '' {
  const first = output.split('\n', 1)[0]?.trim() ?? ''
  const head = parseVerdict(first)
  return head || parseVerdict(output)
}
