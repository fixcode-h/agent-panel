/**
 * 表格页的接口：/tables/:id（id 是项目 id）。
 * 列表、打开、内容搜索、结构文件读写；保存、版本、对比、AI 分析在各自的文件里挂到同一组路由上。
 */
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { Hono, type Context } from 'hono'
import { compress } from 'hono/compress'
import { t } from '../../shared/i18n.ts'
import { TableSchema, TablesConfig, tablesOn } from '../../shared/tables.ts'
import type { Project } from '../../shared/schema.ts'
import { resolvePath } from '../fs.ts'
import { absPath, listTables, openTable, safeRel, searchTables } from './files.ts'
import { readSchema, schemaDir, writeSchema } from './schema-store.ts'
import { HttpError } from './http-error.ts'
import { saveTable } from './write.ts'
import { TableSave } from '../../shared/table-edit.ts'
import { detectVcs } from '../projects-analyze.ts'
import { p4Runner } from '../p4-split.ts'
import { sampleOne, tableSample } from './sample.ts'
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

/** 版本命令在哪个目录跑：项目目录里的表格在项目目录跑，项目目录外的在它所在的目录跑（那边自己的仓库） */
const vcsPath = (dir: string, p: { rel: string; full: string }) =>
  absPath(p.rel) ? { cwd: path.dirname(p.full), rel: path.basename(p.full) } : { cwd: dir, rel: p.rel }

export const fail = (c: Context, e: unknown) =>
  c.json({ error: (e as Error).message }, e instanceof HttpError ? e.status : 400)

export function tablesApi(deps: TablesDeps) {
  return (
    new Hono()
      // 表格内容、列表都是大 JSON（一万行的表几 MB）：压缩后传，局域网 / 远程访问时快很多
      .use(compress())
      // 表格目录里的文件（没开表格功能时是空列表）
      .get('/:id', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          if (!tablesOn(cfg)) return c.json({ dirs: [], missing: [], files: [] })
          return c.json(await listTables(dir, cfg, c.req.query('fresh') === '1'))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 项目设置里还没确认的表格配置：先按它找一遍，每个目录找到几个表格（不保存任何东西）
      .post('/:id/probe', async (c) => {
        try {
          const { dir: saved } = await projectOf(deps, c.req.param('id'))
          const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; tables?: unknown }
          const cfg = TablesConfig.parse(body.tables ?? {})
          // 设置里改了项目目录还没保存：按新填的找（目录不存在时退回已保存的）
          const want = typeof body.path === 'string' && body.path.trim() ? resolvePath(body.path) : saved
          const dir = await stat(want)
            .then((x) => (x.isDirectory() ? want : saved))
            .catch(() => saved)
          const { roots = [], files, truncated } = await listTables(dir, cfg)
          return c.json({ roots, files: files.length, sample: files.slice(0, 5).map((f) => f.path), truncated })
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
          return c.json(await searchTables(dir, files, c.req.query('q') ?? '', c.req.raw.signal))
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
      // AI 分析表格风格：不带 path 是挑出来的几张表的清单；带 path 是这一张的表头 + 前几行（AI 一张一张读）
      .get('/:id/sample', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          if (!tablesOn(cfg)) throw new HttpError(t('先在项目设置里设好表格目录'))
          const one = c.req.query('path')
          if (one) {
            const { rel, full } = safeRel(dir, one, cfg)
            return c.json({ text: await sampleOne(full, rel), files: 1 })
          }
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
          return c.json(await checkTables(dir, files, await readSchema(schemaAt), c.req.raw.signal))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 版本记录：这个文件的历次提交
      .get('/:id/history', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          const { cwd, rel } = vcsPath(dir, safeRel(dir, c.req.query('path') ?? '', cfg))
          return c.json(await tableHistory(cwd, rel))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 某一版的内容（解析好的工作表）
      .get('/:id/at', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          const { cwd, rel } = vcsPath(dir, safeRel(dir, c.req.query('path') ?? '', cfg))
          return c.json({ sheets: await tableAt(cwd, rel, c.req.query('rev') ?? '') })
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
