/** 工作总结、候选教训草稿的接口：从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入，调用方照旧用 api.xxx。
 *  按 shared/api-contract/summary.ts 的契约调 */
import type { SummaryConfig, SummaryCreateRequest, SummaryExtractRequest } from '@shared/summary'
import type { LessonDraftInput } from '@shared/lesson-draft'
import { lessonDraftsContract as L, summaryContract as S } from '@shared/api-contract/summary'
import { call } from './api/call'

export const summaryApi = {
  // ---- 工作总结：选项目生成今天的报告，存最近几份 ----
  summary: () => call(S.list),
  summaryConfig: () => call(S.config),
  saveSummaryConfig: (c: SummaryConfig) => call(S.saveConfig, { body: c }),
  extractSummary: (input: SummaryExtractRequest) => call(S.extract, { body: input }),
  summaryJob: (id: string) => call(S.job, { params: { id } }),
  /** 再次生成：用这份报告的分项开一次待确认（原报告不动，ADR 0043） */
  redoSummary: (id: string) => call(S.redo, { params: { id }, body: {} }),
  stopSummary: (id: string) => call(S.stop, { params: { id }, body: {} }),
  createSummary: (input: SummaryCreateRequest) => call(S.create, { body: input }),
  saveSummary: (id: string, md: string) => call(S.save, { params: { id }, body: { md } }),
  deleteSummary: (id: string) => call(S.remove, { params: { id } }),

  /** 候选教训草稿：从工作总结提炼的半成品，看过后手动写进 docs/lessons/（不会自动落盘） */
  lessonDrafts: () => call(L.list),
  /** 从一份报告提炼；同一份报告只提炼一次 */
  extractLessonDrafts: (reportId: string) => call(L.extract, { body: { reportId } }),
  saveLessonDraft: (id: string, input: LessonDraftInput) => call(L.save, { params: { id }, body: input }),
  deleteLessonDraft: (id: string) => call(L.remove, { params: { id } }),
}
