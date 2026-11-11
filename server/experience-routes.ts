import type { Hono } from 'hono'
import { z } from 'zod'
import {
  ExperienceKind,
  ExperienceSettings,
  ProjectExperience,
  experienceProblems,
  newExperienceId,
} from '../shared/experience.ts'
import { t } from '../shared/i18n.ts'
import type { Agent, Project } from '../shared/schema.ts'
import { askOnce, experienceRun, parseReview, reviewPrompt } from './experience-ai.ts'
import { knowledgeHitsView, missingPaths } from './knowledge-hits.ts'
import { loadProjectExperience, mutateProjectExperience } from './project-experience.ts'
import { loadProjectLessons } from './project-lessons.ts'
import { getSettings } from './settings.ts'

type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

/** 界面上加 / 改一条：字段和存储一样，id、时间由面板定 */
const ExperienceEdit = z.object({
  kind: ExperienceKind,
  title: z.string().trim(),
  body: z.string().trim().default(''),
  keywords: z.array(z.string().trim().min(1)).default([]),
  paths: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
})

/**
 * 项目设置 →「经验」：列出、手动加、改、删，和 AI 评审（逐条判断符不符合「经验记什么」，不符合的由用户勾选后删掉）。
 * 和教训的路由放在一起挂（server/index.ts 有行数上限）；读写都在 server/project-experience.ts
 */
export function experienceRoutes(app: Hono, deps: { projects: Lister<Project>; agents: Lister<Agent> }) {
  const projectOf = async (id: string) => {
    const p = await deps.projects.get(id)
    return p?.path ? p : null
  }
  const noProject = { error: t('项目不存在或没有目录') }

  app.get('/projects/:id/experience', async (c) => {
    const p = await projectOf(c.req.param('id'))
    if (!p) return c.json(noProject, 404)
    return c.json(await loadProjectExperience(p, await deps.agents.list()))
  })

  /** 经验、教训的命中记录和路径失效的条目：设置页按「很久没用上」排序、标过期（shared/knowledge-hits.ts） */
  app.get('/projects/:id/knowledge-hits', async (c) => {
    const p = await deps.projects.get(c.req.param('id'))
    if (!p) return c.json(noProject, 404)
    const agents = await deps.agents.list()
    const exp = p.path ? (await loadProjectExperience(p, agents)).items : []
    const lessons = (await loadProjectLessons(p, agents)).lessons
    return c.json(await knowledgeHitsView(p.id, p.path ?? '', exp, lessons))
  })

  const save = async (projectId: string, id: string, body: unknown) => {
    const p = await projectOf(projectId)
    if (!p) return { error: noProject.error, status: 404 as const }
    const parsed = ExperienceEdit.safeParse(body)
    if (!parsed.success) return { error: z.prettifyError(parsed.error), status: 400 as const }
    const problems = experienceProblems(parsed.data)
    if (problems.length) return { error: problems.join('；'), status: 400 as const }
    const now = new Date().toISOString()
    const r = await mutateProjectExperience(p, await deps.agents.list(), (items) => {
      const old = id ? items.find((x) => x.id === id) : undefined
      if (id && !old) return { items, result: false }
      const next = ProjectExperience.parse({
        ...(old ?? { id: newExperienceId(), source: 'user', taskIds: [], branch: '', createdAt: now }),
        ...parsed.data,
        updatedAt: old ? now : '',
      })
      return { items: old ? items.map((x) => (x === old ? next : x)) : [...items, next], result: true }
    })
    if (!r.ok) return { error: r.error, status: 400 as const }
    if (!r.result) return { error: t('这条经验已经不在了'), status: 404 as const }
    return { items: r.items }
  }

  app.post('/projects/:id/experience', async (c) => {
    const r = await save(c.req.param('id'), '', await c.req.json().catch(() => null))
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.json(r)
  })
  app.put('/projects/:id/experience/:eid', async (c) => {
    const r = await save(c.req.param('id'), c.req.param('eid'), await c.req.json().catch(() => null))
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.json(r)
  })

  /**
   * 按原样写回一条（对话里学到经验卡片的「撤销删除」「撤回这次合并」）：id 不变，有就替换、没有就加回去。
   * expect：写回前这条的 updatedAt 应该是什么；对不上（之后又被改过）时返回 409，界面问过用户再不带 expect 重发
   */
  app.post('/projects/:id/experience/restore', async (c) => {
    const p = await projectOf(c.req.param('id'))
    if (!p) return c.json(noProject, 404)
    const body = z
      .object({ item: ProjectExperience, expect: z.string().optional() })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400)
    const { item, expect } = body.data
    const r = await mutateProjectExperience(p, await deps.agents.list(), (items) => {
      const cur = items.find((x) => x.id === item.id)
      if (expect !== undefined && (cur?.updatedAt ?? '') !== expect) return { items, result: false }
      return { items: cur ? items.map((x) => (x === cur ? item : x)) : [...items, item], result: true }
    })
    if (!r.ok) return c.json({ error: r.error }, 400)
    if (!r.result) return c.json({ error: t('这条经验之后又改过，撤回会丢掉那些改动') }, 409)
    return c.json({ items: r.items })
  })

  /** 删一批（单条删除、AI 评审勾选后删），顺带应用评审给的精简写法 */
  app.post('/projects/:id/experience/apply', async (c) => {
    const p = await projectOf(c.req.param('id'))
    if (!p) return c.json(noProject, 404)
    const body = z
      .object({
        remove: z.array(z.string()).default([]),
        trim: z
          .array(z.object({ id: z.string(), title: z.string().trim().min(1), body: z.string().trim() }))
          .default([]),
      })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400)
    const gone = new Set(body.data.remove)
    const trims = new Map(body.data.trim.map((x) => [x.id, x]))
    const now = new Date().toISOString()
    const r = await mutateProjectExperience(p, await deps.agents.list(), (items) => ({
      items: items
        .filter((x) => !gone.has(x.id))
        .map((x) => {
          const tr = trims.get(x.id)
          return tr ? { ...x, title: tr.title.slice(0, 60), body: tr.body.slice(0, 300), updatedAt: now } : x
        }),
      result: null,
    }))
    return r.ok ? c.json({ items: r.items }) : c.json({ error: r.error }, 400)
  })

  /** AI 评审：面板先核对路径还在不在，再交给模型逐条判断；结果只是建议，删不删由用户勾选 */
  app.post('/projects/:id/experience/review', async (c) => {
    const p = await projectOf(c.req.param('id'))
    if (!p) return c.json(noProject, 404)
    const { items } = await loadProjectExperience(p, await deps.agents.list())
    if (!items.length) return c.json({ verdicts: [] })
    const missing = new Map(Object.entries(await missingPaths(p.path, items)))
    const settings = await getSettings()
    const exp = ExperienceSettings.parse(settings.experience ?? {})
    const run = experienceRun(exp, settings)
    // 一次最多评 120 条：再多提示词太长，分批点几次
    const batch = items.slice(0, 120)
    const res = await askOnce(run, settings, reviewPrompt(batch, missing))
    if (res.error) return c.json({ error: t('AI 评审失败：{error}', { error: res.error }) }, 502)
    const parsed = parseReview(res.text, new Set(batch.map((x) => x.id)))
    if (parsed.error) return c.json({ error: t('AI 评审的回复格式不对：{error}', { error: parsed.error }) }, 502)
    return c.json({ verdicts: parsed.verdicts, missing: Object.fromEntries(missing), total: items.length })
  })
}
