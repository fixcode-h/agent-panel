/**
 * 跨项目批量同步（Trunk → Release 这类）的计算部分：整文件同步预览数一数差几格；
 * 整列同步按主键对行、按字段名对列，算出右边要改的格子。服务端和在线演示共用
 */
import type { SheetData } from './files.ts'
import type { TableSchema } from './tables.ts'
import type { CellSet } from './table-edit.ts'
import { headerOf } from './table-struct.ts'

/** 两份内容差几格（按位置比，整文件同步的预览用） */
export function cellDiffCount(a: SheetData[], b: SheetData[]): number {
  let n = 0
  const names = new Set([...a.map((s) => s.name), ...b.map((s) => s.name)])
  for (const name of names) {
    const x = a.find((s) => s.name === name)?.rows ?? []
    const y = b.find((s) => s.name === name)?.rows ?? []
    for (let r = 0; r < Math.max(x.length, y.length); r++) {
      const p = x[r] ?? []
      const q = y[r] ?? []
      for (let c = 0; c < Math.max(p.length, q.length); c++) if ((p[c] ?? '') !== (q[c] ?? '')) n++
    }
  }
  return n
}

function fieldsOf(schema: TableSchema, file: string, s: SheetData) {
  const h = headerOf(schema, file, s)
  const ni = h.roles.indexOf('name')
  return {
    from: h.start + h.roles.length,
    names: ni < 0 ? [] : (s.rows[h.start + ni] ?? []).map((x) => x.trim()),
  }
}

export interface ColumnSync {
  sheet: string
  cells: CellSet[]
  /** 左边有、右边没有这一行（不加行，只改已有的） */
  missing: number
}

/**
 * 整列同步：右边每张同名工作表里，主键在左边也有的行，把这一列改成左边的值。
 * 主键用右边结构文件里设的，没设用第一列有字段名的；两边都得有这一列和主键列，不然这张表跳过
 */
export function columnSync(
  left: { schema: TableSchema; file: string; sheets: SheetData[] },
  right: { schema: TableSchema; file: string; sheets: SheetData[] },
  field: string,
): ColumnSync[] {
  const out: ColumnSync[] = []
  for (const rs of right.sheets) {
    const ls = left.sheets.find((s) => s.name === rs.name) ?? (left.sheets.length === 1 ? left.sheets[0] : undefined)
    if (!ls) continue
    const R = fieldsOf(right.schema, right.file, rs)
    const L = fieldsOf(left.schema, left.file, ls)
    const key =
      right.schema.style.key && R.names.includes(right.schema.style.key)
        ? right.schema.style.key
        : (R.names.find(Boolean) ?? '')
    const rc = R.names.indexOf(field)
    const rk = R.names.indexOf(key)
    const lc = L.names.indexOf(field)
    const lk = L.names.indexOf(key)
    if (!key || key === field || rc < 0 || rk < 0 || lc < 0 || lk < 0) continue
    const want = new Map<string, string>()
    for (let r = L.from; r < ls.rows.length; r++) {
      const k = (ls.rows[r]?.[lk] ?? '').trim()
      if (k && !want.has(k)) want.set(k, ls.rows[r]?.[lc] ?? '')
    }
    const cells: CellSet[] = []
    const seen = new Set<string>()
    for (let r = R.from; r < rs.rows.length; r++) {
      const k = (rs.rows[r]?.[rk] ?? '').trim()
      const v = want.get(k)
      if (!k || v === undefined) continue
      seen.add(k)
      if ((rs.rows[r]?.[rc] ?? '') !== v) cells.push({ r, c: rc, v })
    }
    out.push({ sheet: rs.name, cells, missing: [...want.keys()].filter((k) => !seen.has(k)).length })
  }
  return out
}
