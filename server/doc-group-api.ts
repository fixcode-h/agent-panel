import { Hono } from 'hono'
import { z } from 'zod'
import { resolveParams } from '../shared/agent-role.ts'
import { findCore } from '../shared/builtin/core.ts'
import { DOC_PLACE_SIBLING, resolveDocRoot, type DocGroupView } from '../shared/doc-root.ts'
import { t } from '../shared/i18n.ts'
import type { Agent, Project } from '../shared/schema.ts'
import { resolveDocGroup, setDocGroupRoot } from './doc-group.ts'
import { detectVcs } from './projects-analyze.ts'

/**
 * 项目设置「文档」一栏看、改各分支共用的文档根（server/doc-group.ts）。
 * 只对文档根在项目外（默认）的 P4 / SVN 项目有；别的项目返回 null，界面就按原来的提示显示
 */
export function docGroupApi(deps: {
  projects: { get(id: string): Promise<Project | null> }
  agents: { list(): Promise<Agent[]> }
}) {
  async function groupOf(id: string) {
    const p = await deps.projects.get(id)
    if (!p?.path) return null
    const vcs = (await detectVcs(p.path).catch(() => null))?.vcs
    const doc = findCore(await deps.agents.list(), 'docsync')
    const values = doc ? resolveParams(doc.params, p.agentParams?.[doc.id] ?? {}).values : {}
    const d = resolveDocRoot(p.path, vcs, values)
    return d && d.place === DOC_PLACE_SIBLING ? { path: p.path, vcs: d.vcs } : null
  }

  return new Hono()
    .get('/:id/doc-group', async (c) => {
      const g = await groupOf(c.req.param('id'))
      return c.json(g ? ((await resolveDocGroup(g.path, g.vcs)) satisfies DocGroupView) : null)
    })
    .put('/:id/doc-group', async (c) => {
      const body = z.object({ root: z.string().trim().min(1) }).safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: t('请填写文档根的完整路径') }, 400)
      if (!/^([A-Za-z]:[\\/]|[\\/])/.test(body.data.root)) return c.json({ error: t('文档根要写完整路径') }, 400)
      const g = await groupOf(c.req.param('id'))
      if (!g) return c.json({ error: t('只有文档放在项目外的 P4 / SVN 项目能改共用文档根') }, 400)
      try {
        return c.json((await setDocGroupRoot(g.path, g.vcs, body.data.root)) satisfies DocGroupView)
      } catch (e) {
        return c.json({ error: t('改文档根失败：{error}', { error: (e as Error).message }) }, 400)
      }
    })
}
