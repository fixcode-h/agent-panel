/**
 * 阶段报告（submit_report）：工作流节点勾了「完成后等我确认」时，Agent 用工具交一份有结构的报告——
 * 结论、决策（问题 + 选项 + 它选的哪个）、方案详情、确认后还要接着做什么。
 * 审阅弹窗按它分区排版，决策画成可以改勾选的卡片；用户确认时交回每个决策选了哪项，
 * 这里算出和 Agent 推荐的差异，原样交回给 Agent（用户 2026-11-15 定：改了哪些要明确告诉 Agent）。
 * 以前弹窗里直接渲染节点的全部文字输出，边做边说的话、决策点、正文混在一起，决策点也只能靠标注回复
 */
import { z } from 'zod'

export const DecisionOption = z.object({
  id: z.string(),
  label: z.string(),
  /** 选这项的代价、影响，一句话 */
  note: z.string().default(''),
})
export type DecisionOption = z.infer<typeof DecisionOption>

export const Decision = z.object({
  /** 编号：Q1、Q2…（自己定的写 M1、M2…），确认结果和返工意见按它引用 */
  id: z.string(),
  title: z.string(),
  /** 问题的背景：为什么要定、不定会怎样 */
  question: z.string().default(''),
  options: z.array(DecisionOption).min(2),
  /** Agent 选的那项（options 的 id） */
  pick: z.string(),
  why: z.string().default(''),
  /** 机械决策：Agent 按规则自己定了，不需要用户拍板，但用户可以改 */
  self: z.boolean().default(false),
  /**
   * 推荐项和用户原话不一致时：哪里不一致、为什么还推荐它。界面上把这条标出来让用户留意
   * （2026-11-26 复盘 P1-2：用户说「黑屏结束抛事件」，推荐的却是另一个时机，而没选的那项自己写着「与原话字面一致」）
   */
  deviates: z.string().optional(),
})
export type Decision = z.infer<typeof Decision>

export const StageReport = z.object({
  /** 结论：这一步得出了什么，两三句 */
  summary: z.string(),
  decisions: z.array(Decision).default([]),
  /** 方案详情（Markdown）：依据、方案正文、风险 */
  details: z.string().default(''),
  /**
   * 确认后这个节点还要问用户的（下一轮的问题）；有它、而且这一版确实问了新问题时，确认后回到 Agent 接着问，不直接往下走。
   * 实现、提交、合并这些交给后面节点的事不算（见 nextRound）
   */
  next: z.string().default(''),
})
export type StageReport = z.infer<typeof StageReport>

/** 用户的选择：决策编号 → 选项编号；没交的按 Agent 推荐的算 */
export type Picks = Record<string, string>

/**
 * 报告的一版（用户 2026-11-15 定：改了决策就重出一版，有版本号，参照诊断报告）。
 * 最后一版没有 result 时就是正在等确认的那一版；result 记用户怎么处理的：
 * confirmed 确认往下走、changed 改了决策退回重出、revised 写了修改意见退回、next 确认了这一轮接着下一轮、
 * auto 接着问的这一版没有新问题，面板直接按通过记下（见 autoSettle）
 */
export const StageReportVersion = z.object({
  report: StageReport,
  at: z.string().default(''),
  picks: z.record(z.string(), z.string()).optional(),
  result: z.enum(['confirmed', 'changed', 'revised', 'next', 'auto']).optional(),
})
export type StageReportVersion = z.infer<typeof StageReportVersion>

/** 正在等确认的那一版：最后一版还没处理过；返工后 Agent 没交新报告时没有 */
export const pendingReport = (list: StageReportVersion[] | undefined) => {
  const v = list?.at(-1)
  return v && !v.result ? v : undefined
}

/**
 * next 写的其实是「没有下一轮」：按空处理。2026-11-26 复盘 P1-1：第 2 版 next 写「无新问题…」，
 * 字段不空，面板照样开了下一轮，设计节点确认了 4 次
 */
const NO_NEXT =
  /^(?:无|没有|暂无|不需要|无需|none|n\/a|nothing|-+|—+)[。.!！，,\s]*$|(?:无|没有|暂无)(?:新的?|其他|别的|更多|待办|后续|下一轮)|交给(?:父对话|下游|后面的?节点)|直接(?:进入|往下|继续)/i

/**
 * 只是在问「确认还是要改」的决策：确认本来就是确认卡的事，写成决策会让面板以为有新问题、再开一轮
 * （复盘 P1-1：第 3 版加了 C1/C2，选项只有「确认 / 还有要改」）
 */
const CONFIRM_ONLY =
  /^(?:确认|同意|通过|没问题|可以|ok|yes|是|否|no|继续|还有要改|有要改的|需要修改|要修改|有修改|不确认|不同意|有意见|再改改?|退回)/i
const confirmOnly = (d: Decision) => d.options.length <= 3 && d.options.every((o) => CONFIRM_ONLY.test(o.label.trim()))

/** 选项说明里自称「和用户原话一致」的写法 */
const MATCHES_WORDS =
  /(?:原话|字面|用户(?:的)?(?:原文|要求|说法|描述))[^。；;，,]{0,6}(?:一致|相符|吻合|对应)|(?:一致|相符|吻合)[^。；;，,]{0,4}(?:原话|字面)/

/** 工具参数校验成报告：选项编号重复、pick 不在选项里这类错直接报回给 Agent 改 */
export function parseStageReport(a: unknown): { ok: true; report: StageReport } | { ok: false; error: string } {
  const r = StageReport.safeParse(a)
  if (!r.success) return { ok: false, error: `报告格式不对：${z.prettifyError(r.error)}` }
  const rep = r.data
  if (!rep.summary.trim()) return { ok: false, error: 'summary 是空的：写这一步的结论' }
  if (NO_NEXT.test(rep.next.trim())) rep.next = ''
  const confirm = rep.decisions.filter(confirmOnly)
  if (confirm.length)
    return {
      ok: false,
      error: `${confirm.map((d) => d.id).join('、')} 只是在问「确认还是要改」：确认由面板的确认卡做，不要写成决策。删掉它们再交；真有要用户选的，写成具体的方案选项。`,
    }
  // 没选的那项自己写着「和用户原话一致」，推荐的却是别的：要么改推荐，要么写清为什么偏离
  for (const d of rep.decisions) {
    const literal = d.options.find((o) => o.id !== d.pick && MATCHES_WORDS.test(`${o.label} ${o.note}`))
    if (literal && !d.deviates?.trim())
      return {
        ok: false,
        error: `${d.id} 的选项 ${literal.id} 写着和用户原话一致，你推荐的却是 ${d.pick}：要么改推荐 ${literal.id}，要么在 deviates 里写清哪里和原话不一致、为什么还这样推荐（界面会把它标出来给用户看）。`,
      }
  }
  // 约定「自己定的写 M1、M2…」：编号是 M 开头却没标 self 的按自己定的算，不当成要用户拍板的新问题
  for (const d of rep.decisions) if (/^M\d+$/i.test(d.id)) d.self = true
  const ids = new Set<string>()
  for (const d of rep.decisions) {
    if (ids.has(d.id)) return { ok: false, error: `决策编号 ${d.id} 重复了` }
    ids.add(d.id)
    const opts = new Set(d.options.map((o) => o.id))
    if (opts.size !== d.options.length) return { ok: false, error: `${d.id} 的选项编号重复了` }
    if (!opts.has(d.pick)) return { ok: false, error: `${d.id} 的 pick「${d.pick}」不在它的选项里` }
  }
  return { ok: true, report: rep }
}

const label = (d: Decision, id: string) => d.options.find((o) => o.id === id)?.label ?? id

/** 最终选的哪项：用户交了而且在选项里就用用户的，否则按 Agent 推荐的 */
export const finalPick = (d: Decision, picks?: Picks) => {
  const p = picks?.[d.id]
  return p && d.options.some((o) => o.id === p) ? p : d.pick
}

/** 用户改了哪些决策 */
export function reportChanges(rep: StageReport, picks?: Picks) {
  return rep.decisions.flatMap((d) => {
    const to = finalPick(d, picks)
    return to === d.pick ? [] : [{ id: d.id, title: d.title, from: label(d, d.pick), to: label(d, to) }]
  })
}

/** 改动差异写成一段话：交给 Agent，也写进对话里的那一行 */
export function changesText(rep: StageReport, picks?: Picks) {
  return reportChanges(rep, picks)
    .map((c) => `- ${c.id}「${c.title}」：你推荐「${c.from}」，用户改选「${c.to}」`)
    .join('\n')
}

/** 同一个节点最多这么多版报告还按 next 回到 Agent：再多交给用户在确认卡上决定（退回写意见） */
export const MAX_REPORT_ROUNDS = 8

/**
 * 这一版的 next 算不算「还有下一轮」：这一版要问出至少一个前面几版没问过的、要用户拍板的决策。
 * 实跑 2026-11-22（DeepSeek V4.1 Flash）：方案节点第一版 next 写「确认后按顺序实现」，面板回「接着做」，它把实现全做了；
 * 之后每版 next 都写一句「没有待办，交给父对话」，决策还是那几个，节点确认 5 次不往下走。
 * 逐轮追问（grilling）每一轮都有新问题，照常接着问
 */
export function nextRound(list: StageReportVersion[] | undefined, v: StageReportVersion): boolean {
  if (!v.report.next.trim()) return false
  const all = list ?? [v]
  if (all.length >= MAX_REPORT_ROUNDS) return false
  const before = new Set(all.slice(0, all.indexOf(v)).flatMap((x) => x.report.decisions.map((d) => d.id)))
  return v.report.decisions.some((d) => !d.self && !before.has(d.id))
}

/**
 * 确认后要不要回到 Agent：用户改了决策（方案要按用户的选择更新）或者还有下一轮问题（nextRound），
 * 返回交给 Agent 的话；都没有返回空串，照常往下走
 */
export function reportFollowUp(rep: StageReport, picks?: Picks, more = !!rep.next.trim()) {
  const diff = changesText(rep, picks)
  if (!diff && !more) return ''
  return [
    diff
      ? `用户确认了这一步的决策，但改了下面几项（没列出的都按你的推荐）：\n${diff}\n\n按用户的选择更新方案，被改动牵连的其他决策和结论一起调整。`
      : '用户确认了这一步的决策，全部按你的推荐。',
    more
      ? `你在报告里说还有下一轮要问：${rep.next.trim()}\n只接着问这些（这个节点的事）；实现、测试、提交这些后面节点的事不要做。`
      : '',
    '做完后同样用 submit_report 交新的阶段报告（已经定下的决策照样列出，pick 写用户定的那项；没有新问题时 next 留空）。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 用户答了确认之后：把这一版标上怎么处理的、选了什么，返回确认后要交给 Agent 的话（空串就是照常往下走）。
 * 在引擎的确认循环里调（单节点和多步节点共用）
 */
export function settleReport(
  list: StageReportVersion[] | undefined,
  c: { allow: boolean; ask?: boolean; picks?: Picks },
): { follow: string; output?: string } {
  const v = pendingReport(list)
  if (!v || c.ask) return { follow: '' }
  v.picks = c.picks
  if (!c.allow) {
    v.result = 'revised'
    return { follow: '' }
  }
  const follow = reportFollowUp(v.report, c.picks, nextRound(list, v))
  v.result = !follow ? 'confirmed' : reportChanges(v.report, c.picks).length ? 'changed' : 'next'
  return { follow, output: follow ? undefined : reportOutput(v.report, c.picks) }
}

/**
 * 下游节点拿到的结果：结论、最终定下的决策、方案详情（边做边说的过程话不交下去）。
 * plain：不写「用户改选」的说明（和上一版对比时只比最终选了什么）
 */
export function reportOutput(rep: StageReport, picks?: Picks, plain = false) {
  const line = (d: Decision) => {
    const p = finalPick(d, picks)
    const by = p === d.pick || plain ? '' : `（用户改选，原推荐「${label(d, d.pick)}」）`
    return `- ${d.id} ${d.title}：${label(d, p)}${by}`
  }
  const ask = rep.decisions.filter((d) => !d.self)
  const own = rep.decisions.filter((d) => d.self)
  return [
    `## 结论\n${rep.summary.trim()}`,
    ask.length ? `## 用户确认的决策\n${ask.map(line).join('\n')}` : '',
    own.length ? `## 按规则定的决策（用户已看过）\n${own.map(line).join('\n')}` : '',
    rep.details.trim() ? `## 方案详情\n${rep.details.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 用户确认了上一版（没改决策）、因为报告里写了 next 回到 Agent 接着问，交上来的这一版却没有新的、要用户拍板的决策：
 * 只是把上一版重述一遍，不再停下来让用户什么都没改又确认一次（用户 2026-11-25：「完全没有调整选项确认还会再出一个报告确认，是不是多余」）。
 * 这时把这一版记成 auto，返回交给下游的结果；要停下来给用户看时返回空串。用户改了决策重出的那版照常给用户看
 */
export function autoSettle(list: StageReportVersion[] | undefined): string {
  const v = pendingReport(list)
  const prev = list?.at(-2)
  if (!list || !v || prev?.result !== 'next') return ''
  const before = new Set(list.slice(0, -1).flatMap((x) => x.report.decisions.filter((d) => !d.self).map((d) => d.id)))
  if (v.report.decisions.some((d) => !d.self && !before.has(d.id))) return ''
  v.result = 'auto'
  return reportOutput(v.report)
}

/**
 * 用户确认的报告里，有没有决策最终选了这项（按选项文字比，包含即算）。
 * 没交过报告时返回 undefined（调用方照常跑，不替它猜）
 */
export function reportPicked(list: StageReportVersion[] | undefined, label: string): boolean | undefined {
  const v = [...(list ?? [])].reverse().find((x) => x.result === 'confirmed' || x.result === 'auto') ?? list?.at(-1)
  if (!v) return undefined
  return v.report.decisions.some((d) =>
    (d.options.find((o) => o.id === finalPick(d, v.picks))?.label ?? '').includes(label),
  )
}
