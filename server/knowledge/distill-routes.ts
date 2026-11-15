import type { Hono } from 'hono'
import { t } from '../../shared/i18n.ts'
import { DistillRequest, type DistillResult } from '../../shared/knowledge/candidate.ts'
import { distill, lessonHook } from '../../shared/knowledge/distill.ts'
import type { Agent, Project } from '../../shared/schema.ts'
import { putHook } from '../hooks/store.ts'
import { readKnowledgeHits } from '../knowledge-hits.ts'
import { loadProjectLessons } from '../projects/lessons.ts'
import { readKnowledgeState } from './store.ts'

type Getter<T> = { get(id: string): Promise<T | null> }
type Lister<T> = { list(): Promise<T[]> }

/**
 * 知识页「提炼」（四期，shared/knowledge/distill.ts）：POST /projects/:id/knowledge/distill。
 * agents / docs / panel / misses 只挑条目、拼提示词，界面拿去开一个项目对话（和「AI 评审」一样），不在这里改文件；
 * hook 把一条教训转成项目用户钩子直接写进钩子设置（用户点的按钮就是确认）
 */
export function distillRoutes(app: Hono, deps: { projects: Getter<Project>; agents: Lister<Agent> }) {
  app.post('/projects/:id/knowledge/distill', async (c) => {
    const p = await deps.projects.get(c.req.param('id'))
    if (!p) return c.json({ error: t('项目不存在') }, 404)
    const req = DistillRequest.safeParse(await c.req.json().catch(() => null))
    if (!req.success) return c.json({ error: t('提炼的请求不对') }, 400)
    const lessons = (await loadProjectLessons(p, await deps.agents.list())).lessons
    if (req.data.target === 'hook') {
      const l = lessons.find((x) => x.id === req.data.lessonId)
      if (!l) return c.json({ ok: false, info: t('这条教训已经不在了') } satisfies DistillResult)
      const def = lessonHook(l, p.id)
      if (!def)
        return c.json({
          ok: false,
          info: t('这条教训里认不出命令：先在教训里写上触发命令再转成钩子'),
        } satisfies DistillResult)
      const saved = await putHook(def)
      return c.json({
        ok: true,
        info: t('已转成钩子：{name}', { name: saved.name }),
        hookId: saved.id,
      } satisfies DistillResult)
    }
    const [hits, state] = await Promise.all([readKnowledgeHits(p.id), readKnowledgeState(p.id)])
    return c.json(distill(req.data.target, p.name, lessons, hits.lessons, state.misses) satisfies DistillResult)
  })
}
