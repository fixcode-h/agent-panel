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
})
export type Decision = z.infer<typeof Decision>

export const StageReport = z.object({
  /** 结论：这一步得出了什么，两三句 */
  summary: z.string(),
  decisions: z.array(Decision).default([]),
  /** 方案详情（Markdown）：依据、方案正文、风险 */
  details: z.string().default(''),
  /** 确认后还要接着做什么（例如下一轮要问的问题）；有它时确认后回到 Agent 接着做，不直接往下走 */
  next: z.string().default(''),
})
export type StageReport = z.infer<typeof StageReport>

/** 用户的选择：决策编号 → 选项编号；没交的按 Agent 推荐的算 */
export type Picks = Record<string, string>

/**
 * 报告的一版（用户 2026-11-15 定：改了决策就重出一版，有版本号，参照诊断报告）。
 * 最后一版没有 result 时就是正在等确认的那一版；result 记用户怎么处理的：
 * confirmed 确认往下走、changed 改了决策退回重出、revised 写了修改意见退回、next 确认了这一轮接着下一轮
 */
export const StageReportVersion = z.object({
  report: StageReport,
  at: z.string().default(''),
  picks: z.record(z.string(), z.string()).optional(),
  result: z.enum(['confirmed', 'changed', 'revised', 'next']).optional(),
})
export type StageReportVersion = z.infer<typeof StageReportVersion>

/** 正在等确认的那一版：最后一版还没处理过；返工后 Agent 没交新报告时没有 */
export const pendingReport = (list: StageReportVersion[] | undefined) => {
  const v = list?.at(-1)
  return v && !v.result ? v : undefined
}

/** 工具参数校验成报告：选项编号重复、pick 不在选项里这类错直接报回给 Agent 改 */
export function parseStageReport(a: unknown): { ok: true; report: StageReport } | { ok: false; error: string } {
  const r = StageReport.safeParse(a)
  if (!r.success) return { ok: false, error: `报告格式不对：${z.prettifyError(r.error)}` }
  const rep = r.data
  if (!rep.summary.trim()) return { ok: false, error: 'summary 是空的：写这一步的结论' }
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

/**
 * 确认后要不要回到 Agent：用户改了决策（方案要按用户的选择更新）或者报告写了接下来还要做的（下一轮问题），
 * 返回交给 Agent 的话；都没有返回空串，照常往下走
 */
export function reportFollowUp(rep: StageReport, picks?: Picks) {
  const diff = changesText(rep, picks)
  if (!diff && !rep.next.trim()) return ''
  return [
    diff
      ? `用户确认了这一步的决策，但改了下面几项（没列出的都按你的推荐）：\n${diff}\n\n按用户的选择更新方案，被改动牵连的其他决策和结论一起调整。`
      : '用户确认了这一步的决策，全部按你的推荐。',
    rep.next.trim() ? `你在报告里说确认后还要：${rep.next.trim()}\n接着做。` : '',
    '做完后同样用 submit_report 交新的阶段报告（已经定下的决策照样列出，pick 写用户定的那项）。',
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
  const follow = reportFollowUp(v.report, c.picks)
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
