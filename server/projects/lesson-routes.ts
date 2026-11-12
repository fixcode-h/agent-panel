import type { Hono } from 'hono'
import { t } from '../../shared/i18n.ts'
import { LESSON_REVIEW_LANG, parseLessonReview, type LessonReviewItem } from '../../shared/lesson-review.ts'
import type { Project } from '../../shared/schema.ts'
import type { LessonDraft } from '../lessons.ts'
import { experienceRoutes } from '../experience/routes.ts'

export interface ProjectLessonApi {
  record(projectId: string, draft: LessonDraft): Promise<{ ok: boolean; info: string; project?: Project }>
  review(projectId: string, item: LessonReviewItem): Promise<{ ok: boolean; info: string; project?: Project }>
}

/**
 * 记一条项目教训、应用一条 AI 评审建议。单独成一个模块是为了让 server/index.ts 不超过文件行数上限
 * （scripts/file-caps.json）；路由本身不碰存储，读写和合并都在 server/projects/lessons.ts。
 */
export function projectLessonRoutes(
  app: Hono,
  lessons: ProjectLessonApi,
  deps: Parameters<typeof experienceRoutes>[1],
) {
  // 项目经验的路由也挂在这里（index.ts 有行数上限）
  experienceRoutes(app, deps)
  // 对话里「记成项目教训」：单独的接口，不用把整个项目设置发回来，也不会盖掉 Agent 刚记的
  app.post('/projects/:id/lessons', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.title !== 'string') return c.json({ error: t('规则不能为空') }, 400)
    const r = await lessons.record(c.req.param('id'), {
      ...(body as Partial<LessonDraft>),
      title: body.title,
      source: 'user',
    })
    return r.ok && r.project ? c.json(r.project) : c.json({ error: r.info }, 400)
  })

  // AI 评审项目教训：用户在评审卡片上逐条点「应用」，一次一条
  app.post('/projects/:id/lessons/review', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { item?: unknown } | null
    const review = parseLessonReview(
      '```' + LESSON_REVIEW_LANG + '\n' + JSON.stringify({ items: [body?.item] }) + '\n```',
    )
    const item = review?.items[0]
    if (!item) return c.json({ error: t('评审建议的格式不对') }, 400)
    const r = await lessons.review(c.req.param('id'), item)
    return r.ok && r.project ? c.json(r.project) : c.json({ error: r.info }, 400)
  })
}
