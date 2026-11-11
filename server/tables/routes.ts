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
import { listTables, openTable, searchTables } from './files.ts'
import { readSchema, schemaDir, writeSchema } from './schema-store.ts'

export interface TablesDeps {
  projects: { get(id: string): Promise<Project | null> }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

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
