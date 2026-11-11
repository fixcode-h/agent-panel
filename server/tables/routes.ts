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
import { backup, saveTable } from './write.ts'
import { SheetEdit, TableSave } from '../../shared/table-edit.ts'
import { detectVcs } from '../projects-analyze.ts'
import { p4Runner } from '../p4-split.ts'
import { sampleOne, tableSample } from './sample.ts'
import { checkTables } from './check.ts'
import { tableAt, tableHistory } from './history.ts'
import { compareProjects } from './compare.ts'
import { checkoutTable } from './checkout.ts'
import { runExport } from './export.ts'
import { enumRename } from './enum-rename.ts'
import { cellHistory } from './cell-history.ts'
import { MAX_SYNC, syncTables, type SyncBody } from './sync.ts'
import { dropProposal, getProposal, putProposal } from './proposals.ts'
import { markResolved, mergeSources, submitTable, vcsStatus } from './vcs-ops.ts'
import type { EnumRename } from '../../shared/table-enum-rename.ts'
import { stream } from 'hono/streaming'
import type { ExportEvent } from '../../shared/table-export.ts'

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
/** P4 管着的只读文件：先签出（不是 P4 项目时返回 false） */
const p4Edit = (dir: string) => async (full: string) => {
  if ((await detectVcs(dir)).vcs !== 'p4') return false
  const r = await p4Runner(dir)(['edit', full])
  return { ok: r.ok, err: r.err || r.out }
}

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
      // 打开着的文件现在的修改时间：页面几秒看一次，被 Excel 或别人改了就提示重新载入
      .get('/:id/stat', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          const { full } = safeRel(dir, c.req.query('path') ?? '', cfg)
          const st = await stat(full).catch(() => null)
          return c.json(st ? { mtime: st.mtime.toISOString(), size: st.size } : { missing: true })
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
          return c.json(await saveTable(dir, project.id, cfg, body.data, { p4Edit: p4Edit(dir) }))
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
          // all=1：导出检查结果，每张表列出全部（最多 10 万处）
          const first = c.req.query('all') === '1' ? 100_000 : 20
          return c.json(await checkTables(dir, files, await readSchema(schemaAt), c.req.raw.signal, first))
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
      // 这个文件在版本管理里的状态：改没改、有没有冲突
      .get('/:id/vcs-status', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          const { cwd, rel } = vcsPath(dir, safeRel(dir, c.req.query('path') ?? '', cfg))
          return c.json(await vcsStatus(cwd, rel))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 只提交这一个文件
      .post('/:id/vcs-submit', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          const b = (await c.req.json()) as { path?: string; message?: string }
          if (cfg.readOnly) throw new HttpError(t('项目设置里把表格设成了只读'), 409)
          const { cwd, rel } = vcsPath(dir, safeRel(dir, String(b.path ?? ''), cfg))
          return c.json(await submitTable(cwd, rel, String(b.message ?? '').slice(0, 2000)))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 开始合并冲突：取共同祖先和对方的内容，工作区里的文件换成干净的「我这边」（换之前备份）
      .post('/:id/merge-start', async (c) => {
        try {
          const { project, dir, cfg } = await projectOf(deps, c.req.param('id'))
          if (cfg.readOnly) throw new HttpError(t('项目设置里把表格设成了只读'), 409)
          const b = (await c.req.json()) as { path?: string }
          const p = safeRel(dir, String(b.path ?? ''), cfg)
          const { cwd, rel } = vcsPath(dir, p)
          return c.json(await mergeSources(cwd, rel, () => backup(project.id, p.rel, p.full)))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 合并保存后标记冲突已解决
      .post('/:id/vcs-resolve', async (c) => {
        try {
          const { dir, cfg } = await projectOf(deps, c.req.param('id'))
          const b = (await c.req.json()) as { path?: string }
          if (cfg.readOnly) throw new HttpError(t('项目设置里把表格设成了只读'), 409)
          const { cwd, rel } = vcsPath(dir, safeRel(dir, String(b.path ?? ''), cfg))
          return c.json(await markResolved(cwd, rel))
        } catch (e) {
          return fail(c, e)
        }
      })
      // 一格的历史：哪几次提交改过它（按主键找同一行、按字段名找同一列）
      .get('/:id/cell-history', async (c) => {
        try {
          const { dir, cfg, schemaAt } = await projectOf(deps, c.req.param('id'))
          const q = c.req.query()
          const p = safeRel(dir, q.path ?? '', cfg)
          const { cwd, rel } = vcsPath(dir, p)
          const at = {
            sheet: q.sheet ?? '',
            field: q.field ?? '',
            keyField: q.keyField || undefined,
            key: q.key || undefined,
            row: Number(q.row) || 0,
          }
          if (!at.field) throw new HttpError(t('这一列没有字段名，看不了历史'))
          return c.json(await cellHistory(cwd, rel, await readSchema(schemaAt), p.rel, at, c.req.raw.signal))
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
      // 把本地文件切换到某一版（整个文件换成那一版的内容），返回切换后的文件
      .post('/:id/checkout', async (c) => {
        try {
          const { project, dir, cfg } = await projectOf(deps, c.req.param('id'))
          const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; rev?: unknown }
          if (typeof body.path !== 'string' || typeof body.rev !== 'string') throw new HttpError(t('参数不对'))
          const p = safeRel(dir, body.path, cfg)
          const vcs = vcsPath(dir, p)
          return c.json(
            await checkoutTable(dir, project.id, cfg, { path: body.path, rev: body.rev }, vcs, {
              p4Edit: p4Edit(vcs.cwd),
            }),
          )
        } catch (e) {
          return fail(c, e)
        }
      })
      // 执行导表脚本：一行一个 JSON（ExportEvent）边跑边推；页面断开（停止）就停掉命令
      .post('/:id/export', async (c) => {
        let ctx: Awaited<ReturnType<typeof projectOf>>
        let body: { script: number; paths: string[] }
        try {
          ctx = await projectOf(deps, c.req.param('id'))
          const raw = (await c.req.json().catch(() => ({}))) as { script?: unknown; paths?: unknown }
          if (
            typeof raw.script !== 'number' ||
            !Array.isArray(raw.paths) ||
            raw.paths.some((x) => typeof x !== 'string')
          )
            throw new HttpError(t('参数不对'))
          body = { script: raw.script, paths: raw.paths as string[] }
          if (!ctx.cfg.exports[body.script]) throw new HttpError(t('找不到这个导表脚本，可能刚在项目设置里删了'), 404)
        } catch (e) {
          return fail(c, e)
        }
        // no-transform：别让上面的压缩把一行行的输出攒成一块再发
        c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
        c.header('Cache-Control', 'no-cache, no-transform')
        c.header('X-Accel-Buffering', 'no')
        return stream(c, async (s) => {
          const ac = new AbortController()
          s.onAbort(() => ac.abort())
          const send = (e: ExportEvent) => s.write(JSON.stringify(e) + '\n').then(() => undefined)
          try {
            await runExport(ctx.dir, ctx.cfg, body, send, ac.signal)
          } catch (e) {
            await send({ type: 'end', index: -1, code: null, error: (e as Error).message })
            await send({ type: 'done', ok: false })
          }
        })
      })
      // 枚举值改名后替换所有表里的旧值：apply=false 只预览
      .post('/:id/enum-rename', async (c) => {
        try {
          const { project, dir, cfg, schemaAt } = await projectOf(deps, c.req.param('id'))
          const body = (await c.req.json().catch(() => ({}))) as { renames?: unknown; apply?: unknown }
          const renames = Array.isArray(body.renames)
            ? body.renames.filter(
                (x): x is EnumRename =>
                  !!x && typeof x.enum === 'string' && typeof x.from === 'string' && typeof x.to === 'string',
              )
            : []
          const { files } = await listTables(dir, cfg)
          const schema = await readSchema(schemaAt)
          return c.json(
            await enumRename(
              { dir, projectId: project.id, cfg, files, schema },
              renames.slice(0, 200),
              body.apply === true,
              { p4Edit: p4Edit(dir) },
              c.req.raw.signal,
            ),
          )
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
      // AI 提的改动（table.propose 存进来，表格页取出来给用户看、放进表格后丢掉）
      .get('/:id/proposal', async (c) => {
        try {
          const { project, dir, cfg } = await projectOf(deps, c.req.param('id'))
          const p = safeRel(dir, c.req.query('path') ?? '', cfg)
          return c.json({ proposal: getProposal(project.id, p.rel) })
        } catch (e) {
          return fail(c, e)
        }
      })
      .post('/:id/proposal', async (c) => {
        try {
          const { project, dir, cfg } = await projectOf(deps, c.req.param('id'))
          const b = (await c.req.json()) as Record<string, unknown>
          const p = safeRel(dir, String(b.path ?? ''), cfg)
          const edit = SheetEdit.parse(b.edit)
          const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
          return c.json(
            putProposal(project.id, {
              path: p.rel,
              sheet: edit.name,
              mtime: String(b.mtime ?? ''),
              edit,
              note: String(b.note ?? '').slice(0, 2000),
              cells: num(b.cells),
              added: num(b.added),
              removed: num(b.removed),
            }),
          )
        } catch (e) {
          return fail(c, e)
        }
      })
      .delete('/:id/proposal', async (c) => {
        try {
          const { project, dir, cfg } = await projectOf(deps, c.req.param('id'))
          const p = safeRel(dir, c.req.query('path') ?? '', cfg)
          dropProposal(project.id, p.rel, c.req.query('pid') || undefined)
          return c.json({ ok: true })
        } catch (e) {
          return fail(c, e)
        }
      })
      // 跨项目批量同步：apply=false 只预览
      .post('/:id/sync', async (c) => {
        try {
          const l = await projectOf(deps, c.req.param('id'))
          const b = (await c.req.json()) as SyncBody & { other?: string }
          const r = await projectOf(deps, String(b.other ?? ''))
          if (!tablesOn(l.cfg) || !tablesOn(r.cfg)) throw new HttpError(t('两个项目都要先设好表格目录'))
          const body: SyncBody = {
            items: Array.isArray(b.items) ? b.items.slice(0, MAX_SYNC) : [],
            mode: b.mode === 'column' ? 'column' : 'file',
            field: typeof b.field === 'string' ? b.field.slice(0, 200) : undefined,
            apply: b.apply === true,
          }
          const side = async (x: typeof l) => ({
            projectId: x.project.id,
            dir: x.dir,
            cfg: x.cfg,
            schema: await readSchema(x.schemaAt),
          })
          return c.json({
            results: await syncTables(await side(l), await side(r), body, { p4Edit: p4Edit(r.dir) }),
          })
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
