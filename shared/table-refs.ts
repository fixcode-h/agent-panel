/**
 * 引用跳转：引用列的值跳到被引用表的那一行；反过来「谁引用了这一行」——
 * 结构文件里所有 ref 指向这张表的列，在那些表里找值等于这一行主键（数组列按分隔符拆开比）的格子。
 * 只读解析好的工作表，不碰文件；表从哪来由调用方给（表格页用已经打开 / 缓存的）。
 */
import type { SheetData } from './files.ts'
import type { TableHit, TableSchema } from './tables.ts'
import { columnInfos, headerOf, parseRef } from './table-struct.ts'

/** 被引用表里值等于 value 的那一行（找不到返回 null） */
export function findRefTarget(
  schema: TableSchema,
  ref: string,
  value: string,
  sheets: SheetData[],
): { sheet: string; row: number; col: number } | null {
  const p = parseRef(ref)
  const v = value.trim()
  if (!p || !v) return null
  const list = p.sheet ? sheets.filter((s) => s.name === p.sheet) : sheets
  for (const s of list) {
    const h = headerOf(schema, p.file, s)
    const names = h.roles.includes('name') ? (s.rows[h.start + h.roles.indexOf('name')] ?? []) : []
    const col = names.findIndex((x) => x.trim() === p.field)
    if (col < 0) continue
    for (let r = h.start + h.roles.length; r < s.rows.length; r++)
      if ((s.rows[r]?.[col] ?? '').trim() === v) return { sheet: s.name, row: r, col }
  }
  return null
}

/** 引用指向 file 的列：「哪个文件#哪张表（* 是全部）#字段」引用了「哪张表的哪个字段」 */
export function refsTo(schema: TableSchema, file: string) {
  const out: { file: string; sheet: string; field: string; target: { sheet?: string; field: string } }[] = []
  for (const [key, col] of Object.entries(schema.columns)) {
    const t = col.ref ? parseRef(col.ref) : null
    if (!t || t.file !== file) continue
    const [f, sheet, field] = key.split('#')
    if (f && field) out.push({ file: f, sheet: sheet || '*', field, target: { sheet: t.sheet, field: t.field } })
  }
  return out
}

/**
 * 谁引用了 file 里的这一行：row 是这一行的「字段名 → 值」。
 * load 读引用方的表；读不到的跳过。最多返回 limit 处
 */
export async function findBackRefs(
  schema: TableSchema,
  file: string,
  sheet: string,
  row: Record<string, string>,
  load: (file: string) => Promise<SheetData[] | undefined>,
  limit = 500,
): Promise<TableHit[]> {
  const hits: TableHit[] = []
  for (const ref of refsTo(schema, file)) {
    if (ref.target.sheet && ref.target.sheet !== sheet) continue
    const value = row[ref.target.field]?.trim()
    if (!value) continue
    const sheets = await load(ref.file)
    for (const s of sheets ?? []) {
      if (ref.sheet !== '*' && ref.sheet !== s.name) continue
      const h = headerOf(schema, ref.file, s)
      const from = h.start + h.roles.length
      const infos = columnInfos(schema, s.rows, h, ref.file, s.name, Math.max(0, ...s.rows.map((x) => x.length)))
      const col = infos.findIndex((i) => i.field === ref.field)
      if (col < 0) continue
      const info = infos[col]
      for (let r = from; r < s.rows.length; r++) {
        const cell = s.rows[r]?.[col] ?? ''
        if (!cell) continue
        const items = info.list ? cell.split(info.sep).map((x) => x.trim()) : [cell.trim()]
        if (!items.includes(value)) continue
        hits.push({ path: ref.file, sheet: s.name, row: r, col, text: cell })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}
