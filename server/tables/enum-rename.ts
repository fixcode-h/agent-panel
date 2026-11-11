/**
 * 枚举值改名后替换所有表里的旧值：先预览（每个文件改几格），确认后逐个文件走原地保存（只改格子、备份、P4 先签出）。
 * 一个文件失败（正被 Excel 打开、只读……）不影响别的，失败的列出来给用户看。
 */
import { stat } from 'node:fs/promises'
import { t } from '../../shared/i18n.ts'
import type { TableFile, TableSchema, TablesConfig } from '../../shared/tables.ts'
import { enumRenameCells, type EnumRename } from '../../shared/table-enum-rename.ts'
import { parseTable, tableFull } from './files.ts'
import { saveTable, type SaveDeps } from './write.ts'
import { HttpError } from './http-error.ts'

export interface EnumRenameResult {
  files: { path: string; cells: number }[]
  /** 写的时候失败的文件和原因（只在 apply 时有） */
  failed: { path: string; error: string }[]
  applied: boolean
}

export async function enumRename(
  ctx: { dir: string; projectId: string; cfg: TablesConfig; files: TableFile[]; schema: TableSchema },
  renames: EnumRename[],
  apply: boolean,
  deps: SaveDeps,
  signal?: AbortSignal,
): Promise<EnumRenameResult> {
  if (!renames.length) throw new HttpError(t('没有要替换的枚举值'))
  if (apply && ctx.cfg.readOnly) throw new HttpError(t('项目设置里把表格设成了只读'), 409)
  const out: EnumRenameResult = { files: [], failed: [], applied: apply }
  let n = 0
  for (const f of ctx.files) {
    if (f.kind === 'xls') continue
    if (signal?.aborted) break
    // 几千个文件：每读几个让一下，别的请求不用等
    if (++n % 20 === 0) await new Promise((r) => setImmediate(r))
    const full = tableFull(ctx.dir, f.path)
    let sheets
    try {
      sheets = (await parseTable(full)).sheets
    } catch {
      continue
    }
    const edits = sheets
      .map((s) => ({ name: s.name, rows: [], cells: enumRenameCells(ctx.schema, f.path, s, renames) }))
      .filter((e) => e.cells.length)
    if (!edits.length) continue
    const cells = edits.reduce((m, e) => m + e.cells.length, 0)
    if (!apply) {
      out.files.push({ path: f.path, cells })
      continue
    }
    try {
      const mtime = (await stat(full)).mtime.toISOString()
      await saveTable(ctx.dir, ctx.projectId, ctx.cfg, { path: f.path, mtime, sheets: edits, force: false }, deps)
      out.files.push({ path: f.path, cells })
    } catch (e) {
      out.failed.push({ path: f.path, error: (e as Error).message })
    }
  }
  return out
}
