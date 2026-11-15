import type { Hono } from 'hono'
import { t } from '../../shared/i18n.ts'
import { CandidateAction, type KnowledgeStateView } from '../../shared/knowledge/candidate.ts'
import { candidateLesson, dropCandidate } from '../../shared/knowledge/capture.ts'
import { lessonSuggestions } from '../../shared/knowledge/lifecycle.ts'
import type { Agent, Project } from '../../shared/schema.ts'
import { recordExperience } from '../experience/learn.ts'
import { missingPaths, readKnowledgeHits } from '../knowledge-hits.ts'
import { loadProjectLessons } from '../projects/lessons.ts'
import { recordLessonDraft } from './recorder.ts'
import { readKnowledgeState, updateKnowledgeState } from './store.ts'

interface Deps {
  projects: { get(id: string): Promise<Project | null> }
  agents: { list(): Promise<Agent[]> }
}

/**
 * 知识页的候选、没配上的查询和升降级建议（设计稿三期）：GET 一次拿全；收下 / 忽略一条候选。
 * 收下时教训走项目教训的同一个记录入口（排队写、同名合并），经验走 recordExperience
 */
export function knowledgeRoutes(app: Hono, deps: Deps) {
  app.get('/projects/:id/knowledge', async (c) => {
    const p = await deps.projects.get(c.req.param('id'))
    if (!p) return c.json({ error: t('项目不存在') }, 404)
    const lessons = (await loadProjectLessons(p, await deps.agents.list())).lessons
    const state = await readKnowledgeState(p.id)
    const hits = await readKnowledgeHits(p.id)
    const stale = p.path ? await missingPaths(p.path, lessons) : {}
    const view: KnowledgeStateView = { ...state, suggestions: lessonSuggestions(lessons, hits.lessons, stale) }
    return c.json(view)
  })

  app.post('/projects/:id/knowledge/candidates/:cid', async (c) => {
    const p = await deps.projects.get(c.req.param('id'))
    if (!p) return c.json({ error: t('项目不存在') }, 404)
    const body = CandidateAction.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('请求格式不对') }, 400)
    const cid = c.req.param('cid')
    const cand = (await readKnowledgeState(p.id)).candidates.find((x) => x.id === cid)
    if (!cand) return c.json({ error: t('这条候选已经不在了') }, 404)
    let project: Project | undefined
    if (body.data.action === 'accept') {
      const r: { ok: boolean; info: string; project?: Project } =
        cand.kind === 'lesson'
          ? await recordLessonDraft(p.id, { ...candidateLesson(cand), source: 'user', taskId: cand.convs[0] ?? '' })
          : p.path
            ? await recordExperience(
                p,
                await deps.agents.list(),
                {
                  kind: cand.expKind || 'locate',
                  title: cand.title,
                  body: cand.body,
                  keywords: cand.keywords,
                  paths: cand.paths,
                },
                cand.convs[0] ?? '',
              )
            : { ok: false, info: t('这个项目没有目录，存不了经验') }
      if (!r.ok) return c.json({ error: r.info }, 400)
      project = r.project
    }
    await updateKnowledgeState(p.id, (cur) => ({ next: dropCandidate(cur, cid), out: null }))
    // 收下的是教训时带上写好的项目：界面拿它更新项目列表
    return c.json({ ok: true, info: '', ...(project ? { project } : {}) })
  })
}
