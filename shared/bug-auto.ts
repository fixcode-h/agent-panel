/**
 * 确认次数按风险收放（分析稿 B2）：
 * - 用户同意某一步时可以勾「后面几步没有要注意的就自动通过」（Diagnosis.autoNext）。之后交上来的根因、方案、修复，
 *   决策卡上没有「要注意」的由面板直接通过（auto），交报告的工具调用当场拿到用户同意时的那段话，不用等用户；
 *   有「要注意」的照常停下等用户。
 * - 修复这一版写了能直接跑的回归测试命令时，要等面板复核（shared/bug-recheck.ts）跑完再决定：
 *   改前失败、改后通过才自动通过，并且验证合在这一次（merged），不再单独交验证。
 * 这几步不自动通过，照常等用户：论证（同意加日志前面板要给文件拍快照，复现贴日志本来就要用户动手）、
 * 验证（要用户自己复现）、「不用改代码」的结论、推翻了之前结论的一版（回到更早的阶段、换掉确认过的方案）。
 * 判断只看阶段、用户的决定和面板算出来的「要注意」，不看回复的文字
 */
import type { Diagnosis } from './bug-diagnosis-schema.ts'
import { diagnosisView } from './bug-diagnosis-md.ts'
import { noFixOf, phaseFeedback, phaseOf, revOf } from './bug-phase.ts'
import { recheckCommands, recheckVerdict } from './bug-recheck.ts'
import { t } from './i18n.ts'

/** 现在开着自动通过没有：看用户最近一次亲手同意的那一版勾没勾（之后用户每次同意都可以改） */
export function autoOn(list: Diagnosis[]): boolean {
  const d = [...list].reverse().find((x) => x.status === 'approved' && !x.auto)
  return !!d?.autoNext
}

/**
 * 这一版能不能由面板自动通过。不能时 why 是给用户看的原因（对话里记一行为什么停下）；
 * 本来就不在自动通过范围里的步骤没有 why。wait 为真：要等面板复核跑完再判（修复这一版写了回归测试命令）
 */
export function autoBlock(
  d: Diagnosis,
  list: Diagnosis[],
  changed?: string[],
): { ok: true } | { ok: false; why?: string; wait?: boolean } {
  if (d.status !== 'pending' || d.awaiting) return { ok: false }
  const phase = phaseOf(d)
  if (phase === 'evidence' || phase === 'verify') return { ok: false }
  if (noFixOf(d)) return { ok: false, why: t('结论是不用改代码，要你看一眼') }
  const i = list.indexOf(d)
  const prev = i > 0 ? list[i - 1] : undefined
  if (prev && revOf(d) > revOf(prev)) return { ok: false, why: t('这一版推翻了之前的结论') }
  if (phase === 'fix' && recheckCommands(d).length) {
    const v = recheckVerdict(d.recheck)
    if (!d.recheck || v === 'running') return { ok: false, wait: true }
    if (v === 'fail') return { ok: false, why: t('面板复核回归测试没通过') }
    if (v !== 'pass') return { ok: false, why: t('面板没能复核全部回归测试') }
  }
  const view = diagnosisView(d, prev, { list, changed })
  if (view.card.attention.length)
    return { ok: false, why: t('有要注意的：{text}', { text: view.card.attention.map((a) => a.text).join('；') }) }
  return { ok: true }
}

/** 自动通过时对话里记的一行（界面文案） */
function autoLine(d: Diagnosis): string {
  const n = revOf(d)
  const what = {
    evidence: t('日志计划'),
    cause: t('根因'),
    plan: t('修复方案'),
    fix: d.merged ? t('修复和验证') : t('修复'),
    verify: t('验证'),
  }[phaseOf(d)]
  return t('第 {n} 版的{what}没有要注意的，按你的设置面板自动通过了', { n, what })
}

/**
 * 面板替用户同意这一版：记成 approved + auto，返回对话里那一行和交给 Agent 的话（和用户点同意时同一段）。
 * 修复这一版复核通过时验证合在一起（merged）
 */
export function autoApprove(d: Diagnosis, now: string): { line: string; feedback: string } {
  d.status = 'approved'
  d.auto = true
  // 自动通过的这一版也带着「之后接着自动」：用户没亲手改过设置之前一直开着
  d.autoNext = true
  if (phaseOf(d) === 'fix' && recheckVerdict(d.recheck) === 'pass') d.merged = true
  d.notes = []
  d.overall = ''
  d.decidedAt = now
  return {
    line: autoLine(d),
    feedback: `用户在之前同意时设了「后面几步没有要注意的就自动通过」，这一版面板核对过没有要注意的，已替用户通过。\n\n${phaseFeedback(d)}`,
  }
}
