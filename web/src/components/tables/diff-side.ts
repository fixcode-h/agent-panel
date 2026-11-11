import type { SheetData } from '@shared/files'
import type { TableSchema } from '@shared/tables'
import { headerOf } from '@shared/table-struct'
import { fieldNames } from '@shared/table-agent'
import { changeSummary } from '@shared/table-summary'
import { diffSheetAsync } from '@/lib/sheet-diff-async'
import { tablesApi } from '@/lib/tables-api'

/** 一张工作表做差异的一边：数据从第几行开始、字段名（按项目的表头） */
export const sideOf = (schema: TableSchema, path: string, sheet: SheetData | undefined) => {
  if (!sheet) return { rows: [] as string[][], from: 0, names: [] as string[] }
  const h = headerOf(schema, path, sheet)
  return { rows: sheet.rows, from: h.start + h.roles.length, names: fieldNames(sheet.rows, h) }
}

/**
 * 提交说明一键生成：取版本控制里的基准版，和磁盘上的现在比（提交前已经保存了），按改动拼一句。
 * 差异在后台线程算
 */
export async function submitSummary(projectId: string, path: string, schema: TableSchema, now: SheetData[]) {
  const hist = await tablesApi.history(projectId, path)
  const base = hist.base ? (await tablesApi.at(projectId, path, hist.base)).sheets : []
  const sheets = await Promise.all(
    now.map(async (s) => {
      const b = sideOf(schema, path, s)
      const a = sideOf(schema, path, base.find((x) => x.name === s.name) ?? (base.length === 1 ? base[0] : undefined))
      return { sheet: s.name, diff: await diffSheetAsync(a, b, schema.style.key), names: b.names }
    }),
  )
  return changeSummary(path, sheets)
}
