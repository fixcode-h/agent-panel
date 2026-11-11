/**
 * 表格页的接口：/tables/:id（id 是项目 id）。
 * 列表、打开、内容搜索、结构文件读写；保存、版本、对比、AI 分析在各自的文件里挂到同一组路由上。
 */
import { stat } from 'node:fs/promises'
import { Hono, type Context } from 'hono'
import { t } from '../../shared/i18n.ts'
import { TableSchema, TablesConfig, tablesOn } from '../../shared/tables.ts'
import type { Project } from '../../shared/schema.ts'
import { resolvePath } from '../fs.ts'
import { listTables, openTable, safeRel, searchTables } from './files.ts'
import { readSchema, schemaDir, writeSchema } from './schema-store.ts'
import { HttpError } from './http-error.ts'
import { saveTable } from './write.ts'
import { TableSave } from '../../shared/table-edit.ts'
import { detectVcs } from '../projects-analyze.ts'
import { p4Runner } from '../p4-split.ts'
import { tableSample } from './sample.ts'
import { checkTables } from './check.ts'
import { tableAt, tableHistory } from './history.ts'
import { compareProjects } from './compare.ts'

export interface TablesDeps {
  projects: { get(id: string): Promise<Project | null> }
}

export { HttpError }

/** 项目、项目目录、表格配置；没开表格功能也给（列表为空） */
export async function projectOf(deps: TablesDeps, id: string) {
  const p = await deps.projects.get(id)
  if (!p) throw new HttpError(t('项目不存在'), 404)
  const dir = p.path ? resolvePath(p.path) : ''
  const ok = dir
    ? await stat(dir)
        .then((x) => x.isDirectory())
        .catch(() => false)
    : false
  if (!ok) throw new HttpError(t('项目目录不存在：{dir}', { dir: p.path || t('（未设置）') }), 404)
  const cfg = TablesConfig.parse(p.tables ?? {})
  return { project: p, dir, cfg, schemaAt: schemaDir(dir, p.id, cfg) }
}

export const fail = (c: Context, e: unknown) =>
  c.json({ error: (e as Error).message }, e instanceof HttpError ? e.status : 400)

export function tablesApi(deps: TablesDeps) {
  return (
    new Hono()
      // 表格目录里的文件（没开表格功能时是空列表）
      .get('/:id', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          if (!tablesOn(cfg)) return c.json({ dirs: [], missing: [], files: [] })
          return c.json(await listTables(dir, cfg))
        } catch (e) {
          return fail(c, e)
        }
      })
      .get('/:id/file', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          return c.json(await openTable(dir, c.req.query('path') ?? '', cfg))
        } catch (e) {
          return fail(c, e)
        }
      })
      .get('/:id/search', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          if (!tablesOn(cfg)) return c.json({ hits: [], files: 0 })
          const { files } = await listTables(dir, cfg)
          return c.json(await searchTables(dir, files, c.req.query('q') ?? ''))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 保存改动：原地改单元格（见 write.ts）
      .post('/:id/save', async (c) => {
        try {
          const { project, dir, cfg } = await projectOf(deps, c.req.param('id'))
          const body = TableSave.safeParse(await c.req.json().catch(() => null))
          if (!body.success) throw new HttpError(t('要保存的改动格式不对'))
          return c.json(
            await saveTable(dir, project.id, cfg, body.data, {
              p4Edit: async (full) => {
                if ((await detectVcs(dir)).vcs !== 'p4') return false
                const r = await p4Runner(dir)(['edit', full])
                return { ok: r.ok, err: r.err || r.out }
              },
            }),
          )
        } catch (e) {
          return fail(c, e)
        }
      })
      // AI 分析表格风格用的样本（几张表的开头几行、类型名出现过的值）
      .get('/:id/sample', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          if (!tablesOn(cfg)) throw new HttpError(t('先在项目设置里设好表格目录'))
          return c.json(await tableSample(dir, (await listTables(dir, cfg)).files))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 全项目检查：每个文件按结构查一遍
      .get('/:id/check', async (c) => {
        try {
          const { dir, cfg, schemaAt } = await projectOf(deps, c.req.param('id'))
          if (!tablesOn(cfg)) return c.json({ files: 0, sheets: [], failed: [] })
          const { files } = await listTables(dir, cfg)
          return c.json(await checkTables(dir, files, await readSchema(schemaAt)))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 版本记录：这个文件的历次提交
      .get('/:id/history', async (c) => {
        try {
          const { dir } = await projectOf(deps, c.req.param('id'))
          const { rel } = safeRel(dir, c.req.query('path') ?? '')
          return c.json(await tableHistory(dir, rel))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 某一版的内容（解析好的工作表）
      .get('/:id/at', async (c) => {
        try {
          const { dir } = await projectOf(deps, c.req.param('id'))
          const { rel } = safeRel(dir, c.req.query('path') ?? '')
          return c.json({ sheets: await tableAt(dir, rel, c.req.query('rev') ?? '') })
        } catch (e) {
          return fail(c, e)
        }
      })
      // 跨项目对比：按相对路径配对两个项目的表格
      .get('/:id/compare', async (c) => {
        try {
          const left = await projectOf(deps, c.req.param('id'))
          const right = await projectOf(deps, c.req.query('other') ?? '')
          if (!tablesOn(left.cfg) || !tablesOn(right.cfg)) throw new HttpError(t('两个项目都要先设好表格目录'))
          return c.json(await compareProjects(left, right))
        } catch (e) {
          return fail(c, e)
        }
      })
      .get('/:id/schema', async (c) => {
        try {
          const { schemaAt } = await projectOf(deps, c.req.param('id'))
          return c.json(await readSchema(schemaAt))
        } catch (e) {
          return fail(c, e)
        }
      })
      .put('/:id/schema', async (c) => {
        try {
          const { schemaAt } = await projectOf(deps, c.req.param('id'))
          const body = TableSchema.safeParse(await c.req.json().catch(() => null))
          if (!body.success) throw new HttpError(t('表格结构格式不对'))
          return c.json(await writeSchema(schemaAt, body.data))
        } catch (e) {
          return fail(c, e)
        }
      })
  )
}
