// Bug 诊断：诊断报告、更新档案、请用户复现，以及取原文。
// 从 shared/engine/host.ts 的 EngineHost / Orchestra 两个大接口里按能力拆出来（重构文档第 5 条），
// 新能力加进对应的小接口或新开一个，不再往大接口上加；成员数由 scripts/structure-check.mjs 盯着
import type { DiagnosisInput } from '../bug/diagnosis.ts'
import type { BugSource } from '../bug/quotes.ts'

/** Orchestra 里 Bug 诊断的那部分（重构文档第 5 条：按能力拆成小接口，Orchestra 只是它们的组合） */
export interface OrchBug {
  /** Bug 诊断报告（ADR 0045）：父对话派来的 Bug 子对话才有，交了等用户确认方案再改 */
  diagnose?: (input: DiagnosisInput) => { ok: boolean; info: string }
  bugCase?: (input: DiagnosisInput) => { ok: boolean; info: string } // update_bug_case（ADR 0046）
  requestLogs?: (input: DiagnosisInput) => { ok: boolean; info: string } // request_logs：加好日志请用户复现
}

/** EngineHost 里 Bug 诊断的那部分 */
export interface BugHost {
  /** Bug 诊断报告交上来时取原文：读项目文件、取引入改动的 diff（shared/bug/quotes.ts）；没有就不取快照 */
  bugSource?: BugSource
}
