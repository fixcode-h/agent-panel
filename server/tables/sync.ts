/**
 * 跨项目批量同步：把左边项目的一批表格同步到右边项目。整文件（字节原样拷过去，右边没有就新建）
 * 或整列（按主键改右边已有行的这一列，走原地保存只改格子）。先预览每个文件会怎样，确认后再写；
 * 每个文件单独成败，失败的原因如实列出来
 */
import { readFile } from 'node:fs/promises'
import { t } from '../../shared/i18n.ts'
import type { TableSchema, TablesConfig } from '../../shared/tables.ts'
import { cellDiffCount, columnSync } from '../../shared/table-sync.ts'
import { openTable, parseTableBuffer, safeRel } from './files.ts'
import { HttpError } from './http-error.ts'
import { replaceTableBytes } from './replace.ts'
import { saveTable, type SaveDeps } from './write.ts'

export interface SyncItem {
  path: string
  left?: string
  right?: string
}

export interface SyncBody {
  items: SyncItem[]
  mode: 'file' | 'column'
  field?: string
  apply: boolean
}

export interface SyncResult {
  path: string
  /** create：右边新建；replace：整个替换；cells：改格子；same：已经一样；skip：跳过（看 error） */
  action: 'create' | 'replace' | 'cells' | 'same' | 'skip'
  /** 差几格 / 改几格 */
  cells: number
  /** 整列同步：左边有、右边没有的行数 */
  missing?: number
  error?: string
}

interface Side {
  projectId: string
  dir: string
  cfg: TablesConfig
  schema: TableSchema
}

/** 一次最多同步这么多个文件 */
export const MAX_SYNC = 500

export async function syncTables(left: Side, right: Side, body: SyncBody, deps: SaveDeps = {}): Promise<SyncResult[]> {
  if (body.apply && right.cfg.readOnly) throw new HttpError(t('右边的项目把表格设成了只读'), 409)
  if (body.mode === 'column' && !body.field?.trim()) throw new HttpError(t('写要同步的字段名'))
  const out: SyncResult[] = []
  for (const it of body.items.slice(0, MAX_SYNC)) {
    const res: SyncResult = { path: it.path, action: 'skip', cells: 0 }
    out.push(res)
    try {
      // 项目目录外的表格目录：只在左边的文件不知道右边该叫什么
      if (it.left && !it.right && it.left !== it.path) throw new HttpError(t('右边没有对应的表格目录，不知道放到哪'))
      const l = safeRel(left.dir, it.left ?? it.path, left.cfg)
      const r = safeRel(right.dir, it.right ?? it.path, right.cfg)
      if (body.mode === 'file') {
        const buf = await readFile(l.full)
        const cur = await readFile(r.full).catch(() => null)
        if (cur && cur.equals(buf)) {
          res.action = 'same'
          continue
        }
        res.action = cur ? 'replace' : 'create'
        res.cells = cur
          ? cellDiffCount((await parseTableBuffer(l.rel, buf)).sheets, (await parseTableBuffer(r.rel, cur)).sheets)
          : 0
        if (body.apply) await replaceTableBytes(right.projectId, r.rel, r.full, buf, deps)
        continue
      }
      const [ld, rd] = await Promise.all([openTable(left.dir, l.rel, left.cfg), openTable(right.dir, r.rel, right.cfg)])
      const per = columnSync(
        { schema: left.schema, file: l.rel, sheets: ld.sheets },
        { schema: right.schema, file: r.rel, sheets: rd.sheets },
        body.field!.trim(),
      )
      if (!per.length) throw new HttpError(t('两边没有都带这一列和主键列的工作表'))
      res.cells = per.reduce((n, s) => n + s.cells.length, 0)
      res.missing = per.reduce((n, s) => n + s.missing, 0)
      res.action = res.cells ? 'cells' : 'same'
      if (body.apply && res.cells)
        await saveTable(
          right.dir,
          right.projectId,
          right.cfg,
          {
            path: r.rel,
            mtime: rd.mtime,
            sheets: per.filter((s) => s.cells.length).map((s) => ({ name: s.sheet, rows: [], cells: s.cells })),
          },
          deps,
        )
    } catch (e) {
      res.action = 'skip'
      res.error = (e as Error).message
    }
  }
  return out
}
