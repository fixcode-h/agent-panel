/**
 * 自建工具的管理接口（ADR 0082）：「技能与 MCP」页的「工具」页签用。试运行和 Agent 调用走同一套校验、守卫前的展开和签出；
 * 人在页面上点的不弹授权卡
 */
import { Hono } from 'hono'
import { customToolsContract as C } from '../../shared/api-contract/custom-tools.ts'
import { CustomTool, ToolScope } from '../../shared/custom-tools/schema.ts'
import { draftProblems } from '../../shared/custom-tools/expand.ts'
import { runText } from '../../shared/custom-tools/text.ts'
import { t } from '../../shared/i18n.ts'
import { projectOf } from '../project-data/index.ts'
import { copyTool, findTool, GLOBAL_TOOLS_DIR, listTools, noteRun, removeTool, saveTool } from './store.ts'
import { execute, prepare } from './run.ts'

const scopeOf = (v: string) => ToolScope.safeParse(v).data

export function customToolsApi() {
  const app = new Hono()
  app.get(C.list.path, async (c) => {
    const projectId = c.req.query('projectId') || undefined
    try {
      const r = await listTools(projectId)
      return c.json({ ...r, globalDir: GLOBAL_TOOLS_DIR })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })
  app.put(C.save.path, async (c) => {
    const body = C.save.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('保存参数不对') }, 400)
    try {
      return c.json(
        await saveTool({
          projectId: body.data.projectId,
          scope: body.data.scope,
          draft: body.data.tool,
          replace: body.data.replace,
          note: body.data.note,
          by: body.data.by || t('我'),
        }),
      )
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  app.delete(C.remove.path, async (c) => {
    const scope = scopeOf(c.req.param('scope'))
    if (!scope) return c.json({ error: t('范围不对') }, 400)
    try {
      return c.json(await removeTool(c.req.query('projectId') || undefined, scope, c.req.param('id')))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  app.post(C.copy.path, async (c) => {
    const scope = scopeOf(c.req.param('scope'))
    const body = C.copy.body.safeParse(await c.req.json().catch(() => null))
    if (!scope || !body.success) return c.json({ error: t('参数不对') }, 400)
    try {
      return c.json(await copyTool(body.data.projectId, scope, c.req.param('id'), body.data.to, body.data.move))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  app.post(C.run.path, async (c) => {
    const body = C.run.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('参数不对') }, 400)
    const { projectId, scope, id, draft, args, dryRun } = body.data
    let tool: CustomTool | undefined
    let where: ToolScope | 'draft' = 'draft'
    if (draft) {
      const r = CustomTool.safeParse({ ...draft, version: 1, history: [] })
      if (!r.success)
        return c.json({ error: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；') }, 400)
      const problems = draftProblems(r.data)
      if (problems.length) return c.json({ error: problems.join('；') }, 400)
      tool = r.data
    } else if (id) {
      const e = await findTool(projectId, id, scope)
      tool = e?.tool
      where = e?.scope ?? 'draft'
    }
    if (!tool) return c.json({ error: t('没有这个工具') }, 404)
    const project = projectId ? await projectOf(projectId).catch(() => undefined) : undefined
    const p = await prepare(tool, args, { projectRoot: project?.path, scope: where })
    if (p.error) return c.json({ ok: false, text: p.error, line: p.line, output: [] })
    if (dryRun) return c.json({ ok: true, text: p.line, line: p.line, output: [] })
    const { result, output } = await execute(tool, p, { projectRoot: project?.path, signal: c.req.raw.signal })
    if (where !== 'draft')
      noteRun(where, tool.id, projectId, {
        at: new Date().toISOString(),
        ok: result.ok,
        ms: result.ms,
        summary: result.errors[0]?.msg ?? result.tail.at(-1) ?? '',
      })
    return c.json({ ok: result.ok, text: runText(tool, result), line: p.line, output })
  })
  return app
}
