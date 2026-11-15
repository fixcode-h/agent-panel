/**
 * 工作总结和候选教训草稿的接口契约（写法见 ./define.ts；服务端 server/summary/index.ts、server/lesson-drafts.ts，
 * 演示 web/src/lib/demo/demo-summary.ts）。结构本身（报告、分项、草稿）在 shared/summary、shared/lesson-draft.ts
 */
import { z } from 'zod'
import { LessonDraftInput, LessonDraftRecord } from '../lesson-draft.ts'
import {
  SUMMARY_GRAINS,
  SUMMARY_SOURCES,
  SummaryConfig,
  SummaryCreateRequest,
  SummaryEntry,
  SummaryExtractRequest,
  SummaryRecord,
  type SummaryJob,
} from '../summary/index.ts'
import { endpoint, shaped } from './define.ts'

/** 一次提炼：只查界面必读的字段，完整类型是 shared/summary 的 SummaryJob */
const Job = shaped<SummaryJob>(
  z.looseObject({
    id: z.string(),
    status: z.enum(['running', 'done', 'failed', 'stopped']),
    source: z.enum(SUMMARY_SOURCES),
    grain: z.enum(SUMMARY_GRAINS),
    from: z.string(),
    to: z.string(),
    projectIds: z.array(z.string()),
    items: z.array(SummaryEntry),
    taskCount: z.number(),
    reportCount: z.number(),
    cli: z.string(),
    model: z.string(),
    effort: z.string(),
    tools: z.array(z.string()),
    outChars: z.number(),
    startedAt: z.number(),
  }),
)
const Drafts = z.object({ drafts: z.array(LessonDraftRecord) })

export const summaryContract = {
  /** 存下来的报告，新的在前 */
  list: endpoint({ method: 'GET', path: '/summary', res: z.object({ reports: z.array(SummaryRecord) }) }),
  config: endpoint({ method: 'GET', path: '/summary/config', res: SummaryConfig }),
  saveConfig: endpoint({ method: 'PUT', path: '/summary/config', body: SummaryConfig, res: SummaryConfig }),
  /** 开始一次提炼：马上返回作业，页面按 job 查进度 */
  extract: endpoint({ method: 'POST', path: '/summary/extract', body: SummaryExtractRequest, res: Job }),
  job: endpoint({ method: 'GET', path: '/summary/jobs/:id', res: Job }),
  /** 再次生成：用这份报告的分项开一次待确认（原报告不动，ADR 0043） */
  redo: endpoint({ method: 'POST', path: '/summary/:id/redo', body: z.object({}), res: Job }),
  stop: endpoint({ method: 'POST', path: '/summary/jobs/:id/stop', body: z.object({}), res: Job }),
  create: endpoint({ method: 'POST', path: '/summary', body: SummaryCreateRequest, res: SummaryRecord }),
  save: endpoint({
    method: 'PUT',
    path: '/summary/:id',
    body: z.object({ md: z.string().max(200_000) }),
    res: SummaryRecord,
  }),
  remove: endpoint({ method: 'DELETE', path: '/summary/:id', res: z.object({ ok: z.literal(true) }) }),
}

export const lessonDraftsContract = {
  list: endpoint({ method: 'GET', path: '/lesson-drafts', res: Drafts }),
  /** 从一份报告提炼；同一份报告只补草稿区还没有的条目 */
  extract: endpoint({
    method: 'POST',
    path: '/lesson-drafts',
    body: z.object({ reportId: z.string().min(1) }),
    res: Drafts.extend({ created: z.number(), info: z.string() }),
  }),
  save: endpoint({ method: 'PUT', path: '/lesson-drafts/:id', body: LessonDraftInput, res: LessonDraftRecord }),
  remove: endpoint({ method: 'DELETE', path: '/lesson-drafts/:id', res: z.void() }),
}
