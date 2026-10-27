/**
 * 候选教训草稿区：工作总结生成后从这里提炼、编辑、丢弃，**不会自动写进 docs/lessons/**。
 * 提炼规则在 shared/lesson-draft.ts（纯函数，能单测）；这里只管存取和「同一份报告不重复提炼」。
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  LessonDraftInput,
  LessonDraftRecord,
  lessonDraftProblems,
  lessonDraftsFromReport,
  missingDrafts,
} from '../shared/lesson-draft.ts'
import type { SummaryRecord } from '../shared/summary.ts'
import { t } from '../shared/i18n.ts'
import { log } from './log.ts'

type Drafts = {
  list(): Promise<LessonDraftRecord[]>
  create(input: LessonDraftInput): Promise<LessonDraftRecord>
  update(id: string, input: LessonDraftInput): Promise<LessonDraftRecord | null>
  remove(id: string): Promise<boolean>
}

export function lessonDraftsApi(deps: { drafts: Drafts; reports: { list(): Promise<SummaryRecord[]> } }) {
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  /** 新的在前：界面上先看到刚提炼出来的 */
  const newest = async () => (await deps.drafts.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  return {
    routes: new Hono()
      .get('/', async (c) => c.json({ drafts: await newest() }))
      /**
       * 从一份报告提炼候选草稿：只补草稿区还没有的条目（按标题判重）。
       * 不整份重新生成——用户可能已经改过在的草稿，覆盖掉就是静默丢他的东西；
       * 丢掉一条后再点提炼能找回来，不用把剩下的也丢掉。
       */
      .post('/', async (c) => {
        const p = z.object({ reportId: z.string().min(1) }).safeParse(await c.req.json())
        if (!p.success) return bad(c, z.prettifyError(p.error))
        const report = (await deps.reports.list()).find((r) => r.id === p.data.reportId)
        if (!report) return bad(c, t('找不到这份报告'), 404)
        const found = lessonDraftsFromReport(report)
        const had = (await deps.drafts.list()).filter((d) => d.reportId === report.id)
        const missing = missingDrafts(found, had)
        for (const x of missing) await deps.drafts.create(x)
        if (missing.length) log.info('lessons', '从工作总结提炼了候选教训', { report: report.id, n: missing.length })
        return c.json({
          drafts: await newest(),
          created: missing.length,
          info: missing.length
            ? ''
            : found.length
              ? t('这份报告的候选教训都已经在草稿区了')
              : t('这份报告里没有可提炼的返工，不硬造条目'),
        })
      })
      .put('/:id', async (c) => {
        const p = LessonDraftInput.safeParse(await c.req.json())
        if (!p.success) return bad(c, z.prettifyError(p.error))
        // 和页面上的保存按钮同一个判据（shared/lesson-draft.ts）：落到分片时才发现超标就晚了
        const problems = lessonDraftProblems(p.data)
        if (problems.length) return bad(c, problems.join('；'))
        const next = await deps.drafts.update(c.req.param('id'), p.data)
        return next ? c.json(next) : bad(c, t('找不到这条草稿'), 404)
      })
      .delete('/:id', async (c) =>
        (await deps.drafts.remove(c.req.param('id'))) ? c.body(null, 204) : bad(c, t('找不到这条草稿'), 404),
      ),
  }
}
