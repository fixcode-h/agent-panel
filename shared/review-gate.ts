import type { PlanStep, TaskStep } from './schema.ts'
import { leadVerdict } from './verdict.ts'

/**
 * 评审门禁：子对话合回父对话分支之前，必须
 * 1) 计划里有一条标了 review 的评审步骤（执行角色会把它单独写进计划，用户能在计划面板上看到）；
 * 2) 那一步已经完成（派评审时标等待中，拿回结论后标完成）；
 * 3) 评审子任务真的跑过、写了结论；
 * 4) 结论是通过且没有列高级 / 中级，或者执行角色对最近一次评审的每条高级、中级都写了自己的处置（review_triage）。
 *
 * 第 4 条是 ADR 0009 的核心：评审只出意见，采不采纳由执行角色核实之后决定，门禁不要求「评审说通过」。
 * 以前门禁只认评审的「通过」，执行角色又被要求「不要自己把 🛑 判成不重要」，于是每轮复看都换个角度挑出新的 🛑，
 * 执行逐条打补丁再复看，收尾阶段一直循环。现在门禁只保证每条高级、中级都被看过、有结论和理由，
 * 处置连同收尾请求一起交给父对话（合并就是验收），驳回得没道理的由父对话打回。
 *
 * 前两条读计划（PlanStep.review），后两条读 steps 里 slot 为 sub 的评审子任务——
 * 评审就是一次普通的 spawn_agents，结论写在它的输出里：不另存状态，也不另造一套和现有工具并行的机制。
 */
export type ReviewGate = { ok: true } | { ok: false; info: string }

/** 执行角色对一条高级 / 中级意见的处置：fix 核实是真问题并已改；reject 核实不成立；defer 是真问题但这次不改（记已知问题） */
export interface TriageItem {
  /** 评审意见的编号（R1、R2…）；评审没编号时写意见的原话摘要 */
  id: string
  decision: 'fix' | 'reject' | 'defer'
  /** 为什么这么处置：怎么核实的（读了哪段代码、跑了什么）、改法或驳回的反例、不改的影响面 */
  reason: string
}

export const TRIAGE_DECISIONS: Record<TriageItem['decision'], string> = {
  fix: '已修',
  reject: '不采纳',
  defer: '留作已知问题',
}

/** 理由短于这个字数就当没写：「同意」「不改」这种一两个字的处置说明不了怎么核实的 */
const MIN_REASON = 8

/** 怎么派评审：拒绝时连这段一起给子对话，它照着做就能过 */
export const REVIEW_TIP = [
  '收尾前先派一次「评审」（spawn_agents 的 agent 写「评审」），并在计划里单独列出「评审本次改动」这一步（标 review: true）：',
  '- 派评审时把这一步标成等待中，拿回结论后标完成；',
  '- 改动由面板附进评审的提示词（git 仓库），instructions 里写清：这次的需求和验收标准、父对话划的范围、改到的模块和对应的模块文档路径、已经跑过的检查（命令 + 结果）；',
  '- 要它**第一行**先单独写「验收结论：通过」或「验收结论：不通过」，第二行写「必须处置：R1、R2…」（列出高级和中级的编号，没有写「必须处置：无」），再按 🔴 高级 / 🟠 中级 / 🟡 低级 / 💡 建议列意见：子任务输出太长时面板只留开头，写在末尾会被截掉，门禁就读不到。',
  '拿回意见后逐条自己核实再决定修不修（评审的意见是线索，不是结论）；修了要复看时用 spawn_agents 的 resume 接着上一次评审的会话，面板只附增量。最后跑完整测试，调用 submit_merge 时在 review_triage 里写清最近一次评审每条高级、中级的处置。',
].join('\n')

/** 计划里还没有标 review 的步骤 */
const NO_STEP = `没有请求收尾：计划里缺少评审步骤。执行角色收尾时要把评审单独写进计划（set_plan 里一条主步骤，标题写清是评审，并标 review: true）——放在别的步骤的子步骤里不算：派评审时标等待中，拿回结论后标完成，计划面板上能看到这一步才算数。`

/**
 * 需要处置的意见行：以 🔴 高级、🟠 中级（🛑 是还在用三级时的「必须改」）开头。只认行首：
 * 复看里常见「上一轮的高级 R1 已改好」这种正文，按全文找会把已经处置过的编号又算一遍
 */
const MUST = /^[\s>*#\-\d.、]*(🔴|🟠|🛑|【?高级|【?中级)/

/**
 * 评审列出的、要执行角色处置的编号（高级和中级）：第二行「必须处置：R1、R2」优先（写在开头，输出被截断也读得到），
 * 再补上正文里带高级 / 中级标记的行里出现的编号。没编号时返回空数组
 */
export function blockingIds(output: string): string[] {
  const ids = new Set<string>()
  const lines = output.split('\n')
  const head = lines.slice(0, 3).find((l) => /必须(处置|改)\s*[:：]|blockers?\s*[:：]/i.test(l))
  for (const m of head?.matchAll(/\bR\d+\b/g) ?? []) ids.add(m[0])
  for (const l of lines) if (MUST.test(l)) for (const m of l.matchAll(/\bR\d+\b/g)) ids.add(m[0])
  return [...ids]
}

export function reviewGate(
  steps: TaskStep[],
  isReviewer: (agentId: string) => boolean,
  planSteps: PlanStep[] = [],
  triage: TriageItem[] = [],
): ReviewGate {
  // 不止一步时要全部完成：只看第一条会把「第一份已完成、第二份还在等」当成做完了
  const planReviews = planSteps.filter((s) => s.review)
  if (!planReviews.length) return { ok: false, info: `${NO_STEP}\n\n${REVIEW_TIP}` }
  const open = planReviews.find((s) => s.status !== 'done')
  if (open)
    return {
      ok: false,
      info: `没有请求收尾：计划里的评审步骤「${open.title}」还没完成（现在是「${open.status}」）。等评审给出结论、你逐条核实处理完，把这一步标完成之后才调用 submit_merge。`,
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
  const verdict = leadVerdict(last.output)
  if (!verdict)
    return {
      ok: false,
      info: `没有请求收尾：最近一次评审「${last.title}」没有写验收结论。让它第一行单独写「验收结论：通过」或「验收结论：不通过」（回复用英文时写「Verdict: pass」或「Verdict: fail」），再调用 submit_merge。`,
    }
  // 通过也可能带着中级（不判不通过，但要处置）；没编号的标记行不算（复看里常见「上一轮的高级都已改掉」）
  if (verdict === 'pass' && !blockingIds(last.output).length) return { ok: true }
  return triageGate(last, triage)
}

/** 评审列了高级 / 中级：执行角色要对每条写下自己的处置，缺的、理由太短的都列出来 */
function triageGate(last: TaskStep, triage: TriageItem[]): ReviewGate {
  const how =
    '对每条高级、中级先自己核实（读它指的代码、按它的推导或反例推一遍），再在 review_triage 里写处置：fix（真问题、在这次范围里、已改并验证）、reject（核实不成立，写出反例或代码依据）、defer（真问题但在范围外 / 只在构造的极端数据上成立 / 代价大于收益，写影响面，交接时列为已知问题）。不要评审说什么就改什么，也不要不核实就驳回。'
  const valid = triage.filter((x) => x.id.trim() && x.decision in TRIAGE_DECISIONS)
  const short = valid.filter((x) => x.reason.trim().length < MIN_REASON)
  if (short.length)
    return {
      ok: false,
      info: `没有请求收尾：review_triage 里 ${short.map((x) => x.id).join('、')} 的理由太短。写清你怎么核实的、为什么这么处置。`,
    }
  const ids = blockingIds(last.output)
  if (!ids.length) {
    if (valid.length) return { ok: true }
    return {
      ok: false,
      info: `没有请求收尾：最近一次评审「${last.title}」的结论是不通过，你还没写处置。${how}评审没给编号时，id 写那条意见的原话摘要。`,
    }
  }
  const done = new Set(valid.map((x) => x.id.trim().toUpperCase()))
  const missing = ids.filter((id) => !done.has(id.toUpperCase()))
  if (!missing.length) return { ok: true }
  return {
    ok: false,
    info: `没有请求收尾：最近一次评审「${last.title}」的高级 / 中级里 ${missing.join('、')} 还没有处置。${how}`,
  }
}

/** 处置写成给父对话和交接摘要看的几行 */
export function triageText(triage: TriageItem[]) {
  return triage.map((x) => `- ${x.id}：${TRIAGE_DECISIONS[x.decision] ?? x.decision}。${x.reason.trim()}`).join('\n')
}

/** 工具参数里的处置：模型传什么都可能，认不出的项丢掉 */
export function triageInput(raw: unknown): TriageItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      id: String(x.id ?? '').trim(),
      decision: String(x.decision ?? '').trim() as TriageItem['decision'],
      reason: String(x.reason ?? ''),
    }))
    .filter((x) => x.id && x.decision in TRIAGE_DECISIONS)
}
