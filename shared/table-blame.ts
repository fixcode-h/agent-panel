/**
 * 一格的历史（按格子 blame）：拿到这个文件每一版里这一格的值（按主键找同一行、按字段名找同一列），
 * 值和更早一版不一样的那次提交就是改了它的提交。服务端和在线演示共用
 */
import type { SheetData } from './files.ts'
import type { TableSchema } from './tables.ts'
import { headerOf } from './table-struct.ts'

/** 要看历史的这一格 */
export interface CellAt {
  sheet: string
  field: string
  /** 主键字段名和这一行的主键；没有主键时按行号找（插删过行会不准） */
  keyField?: string
  key?: string
  row: number
}

export interface CellChange<R> {
  rev: R
  /** 这次提交之前的值；那时还没有这一行（或这一列）时为 null */
  from: string | null
  to: string | null
}

/** 在一版内容里找这一格的值：找不到这一行 / 这一列 / 这张工作表时为 null */
export function cellIn(schema: TableSchema, file: string, sheets: SheetData[], at: CellAt): string | null {
  const s = sheets.find((x) => x.name === at.sheet) ?? (sheets.length === 1 ? sheets[0] : undefined)
  if (!s) return null
  const h = headerOf(schema, file, s)
  const ni = h.roles.indexOf('name')
  if (ni < 0) return null
  const names = (s.rows[h.start + ni] ?? []).map((x) => x.trim())
  const col = names.indexOf(at.field)
  if (col < 0) return null
  let r = at.row
  if (at.keyField && at.key !== undefined && at.key !== '') {
    const kc = names.indexOf(at.keyField)
    if (kc < 0) return null
    r = -1
    for (let i = h.start + h.roles.length; i < s.rows.length; i++)
      if ((s.rows[i]?.[kc] ?? '').trim() === at.key) {
        r = i
        break
      }
    if (r < 0) return null
  }
  if (r >= s.rows.length) return null
  return s.rows[r]?.[col] ?? ''
}

/**
 * revs、values 从新到旧一一对应。最老的一版之前看不到了：那一版有值就算「那时加的」，
 * 中间某版找不到这一格（行被删过又加回来）也算一次变化
 */
export function cellChanges<R>(revs: R[], values: (string | null)[]): CellChange<R>[] {
  const out: CellChange<R>[] = []
  for (let i = 0; i < values.length; i++) {
    const before = i + 1 < values.length ? values[i + 1] : null
    if (values[i] !== before) out.push({ rev: revs[i], from: before, to: values[i] })
  }
  return out
}
