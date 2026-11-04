/** 工作总结、候选教训草稿的接口：从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入，调用方照旧用 api.xxx */
import type {
  SummaryConfig,
  SummaryCreateRequest,
  SummaryExtractRequest,
  SummaryJob,
  SummaryRecord,
} from '@shared/summary'
import type { LessonDraftInput, LessonDraftRecord } from '@shared/lesson-draft'
import { json, request } from './api'

export const summaryApi = {
  // ---- 工作总结：选项目生成今天的报告，存最近几份 ----
  summary: () => request<{ reports: SummaryRecord[] }>('/summary'),
  summaryConfig: () => request<SummaryConfig>('/summary/config'),
  saveSummaryConfig: (c: SummaryConfig) => request<SummaryConfig>('/summary/config', json('PUT', c)),
  extractSummary: (input: SummaryExtractRequest) => request<SummaryJob>('/summary/extract', json('POST', input)),
  summaryJob: (id: string) => request<SummaryJob>(`/summary/jobs/${id}`),
  /** 再次生成：用这份报告的分项开一次待确认（原报告不动，ADR 0043） */
  redoSummary: (id: string) => request<SummaryJob>(`/summary/${id}/redo`, json('POST', {})),
  stopSummary: (id: string) => request<SummaryJob>(`/summary/jobs/${id}/stop`, json('POST', {})),
  createSummary: (input: SummaryCreateRequest) => request<SummaryRecord>('/summary', json('POST', input)),
  saveSummary: (id: string, md: string) => request<SummaryRecord>(`/summary/${id}`, json('PUT', { md })),
  deleteSummary: (id: string) => request<{ ok: true }>(`/summary/${id}`, { method: 'DELETE' }),

  /** 候选教训草稿：从工作总结提炼的半成品，看过后手动写进 docs/lessons/（不会自动落盘） */
  lessonDrafts: () => request<{ drafts: LessonDraftRecord[] }>('/lesson-drafts'),
  /** 从一份报告提炼；同一份报告只提炼一次 */
  extractLessonDrafts: (reportId: string) =>
    request<{ drafts: LessonDraftRecord[]; created: number; info: string }>(
      '/lesson-drafts',
      json('POST', { reportId }),
    ),
  saveLessonDraft: (id: string, input: LessonDraftInput) =>
    request<LessonDraftRecord>(`/lesson-drafts/${id}`, json('PUT', input)),
  deleteLessonDraft: (id: string) => request<void>(`/lesson-drafts/${id}`, { method: 'DELETE' }),
}
