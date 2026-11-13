/**
 * 用户报的 Bug 不用提问工具问用户（用户 2026-11-13 报的：诊断停在论证第 1 轮，Agent 却弹提问窗口问「用哪个方案」）。
 * 这类对话和用户来回只走诊断报告（ADR 0045）：选哪个修法写进修复方案、用户在审阅弹窗里确认或点「改用方案 X」，
 * 报告和阶段条才跟着往下走；走提问工具的话，答案不进报告，阶段条也一直停在原地。
 * 「提问」开关开着时问题会交给父对话再弹给用户，关着时让它「按你的判断选」——两种都绕开了报告，所以开关不管开没开都改道。
 * 交给 Agent 的话是提示词，不翻译。
 */
import { inPlaceBugClosed } from './in-place.ts'

/** 改道时交回给 CLI 的话：说清选方案、缺信息各写进报告哪里 */
export const BUG_ASK_REDIRECT =
  '这是用户报的 Bug，和用户的来回只走诊断报告，不用提问工具问（这个问题没有交给用户）：' +
  '要用户选修法的，写进修复方案（submit_diagnosis phase: plan：候选方案和五项比较、选定的方案和理由），用户在报告弹窗里确认或点「改用方案 X」；' +
  '根因还没证实、拿不准该选哪个的，先交论证（phase: evidence），用户复现拿到日志再定；' +
  '要用户补的信息（复现步骤、环境、日志在哪）写进这一版报告（论证的 collect 写清要用户做什么、贴回什么）。' +
  '现在按流程把当前阶段的报告交上去，结束这一轮等用户在弹窗里的决定。'

/** 这个对话的提问要不要改道成交报告：用户报的 Bug 还没结束时要；普通对话里的 Bug 修完或不修了就恢复正常提问 */
export function bugAskRedirect(task: Parameters<typeof inPlaceBugClosed>[0]) {
  return task.bug?.kind === 'report' && !inPlaceBugClosed(task) ? BUG_ASK_REDIRECT : undefined
}
