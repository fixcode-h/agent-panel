/**
 * 全项目检查：每个表格文件按结构文件查一遍（类型、枚举、引用、范围、主键重复），
 * 和表格页上标红用的是同一份规则（shared/table-struct.ts）。只读文件。
 */
import type { SheetData } from '../../shared/files.ts'
import type { TableFile, TableSchema } from '../../shared/tables.ts'
import { checkWorkbook, workbookNeeds, type SheetProblems } from '../../shared/table-struct.ts'
import { parseTable, tableFull } from './files.ts'

export interface TablesCheck {
  /** 查了几个文件 */
  files: number
  sheets: SheetProblems[]
  /** 打不开的文件和原因 */
  failed: { path: string; error: string }[]
}

export async function checkTables(dir: string, files: TableFile[], schema: TableSchema): Promise<TablesCheck> {
  const loaded = new Map<string, SheetData[] | null>()
  const load = async (rel: string) => {
    if (!loaded.has(rel))
      loaded.set(
        rel,
        await parseTable(tableFull(dir, rel)).then(
          (d) => d.sheets,
          () => null,
        ),
      )
    return loaded.get(rel) ?? undefined
  }
  const out: TablesCheck = { files: 0, sheets: [], failed: [] }
  for (const f of files) {
    if (f.kind === 'xls') continue
    let sheets: SheetData[]
    try {
      sheets = (await parseTable(tableFull(dir, f.path))).sheets
    } catch (e) {
      out.failed.push({ path: f.path, error: (e as Error).message })
      continue
    }
    out.files++
    for (const need of workbookNeeds(schema, f.path, sheets)) await load(need)
    out.sheets.push(...checkWorkbook(schema, f.path, sheets, (x) => loaded.get(x) ?? undefined))
  }
  return out
}
