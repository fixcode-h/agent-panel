/**
 * 枚举值改名后一键替换：所有用这个枚举的列（类型名就是枚举名，或列结构里指定了它）里，
 * 等于旧名字的格子换成新名字；数组列按分隔符拆开逐项换，分隔符照原样。只算要改的格子，写文件由调用方做。
 */
import type { SheetData } from './files.ts'
import type { TableSchema } from './tables.ts'
import type { CellSet } from './table-edit.ts'
import { columnInfos, headerOf } from './table-struct.ts'

export interface EnumRename {
  enum: string
  from: string
  to: string
}

export function enumRenameCells(schema: TableSchema, file: string, sheet: SheetData, renames: EnumRename[]): CellSet[] {
  if (!renames.length) return []
  const h = headerOf(schema, file, sheet)
  const cols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const infos = columnInfos(schema, sheet.rows, h, file, sheet.name, cols)
  const out: CellSet[] = []
  for (const info of infos) {
    if (!info.enumName || info.remark) continue
    const map = new Map(renames.filter((x) => x.enum === info.enumName).map((x) => [x.from, x.to]))
    if (!map.size) continue
    for (let r = h.start + h.roles.length; r < sheet.rows.length; r++) {
      const v = sheet.rows[r]?.[info.col] ?? ''
      if (!v) continue
      let next: string
      if (info.list) {
        const parts = v.split(info.sep)
        next = parts.map((p) => (map.has(p.trim()) ? p.replace(p.trim(), map.get(p.trim())!) : p)).join(info.sep)
      } else next = map.has(v.trim()) ? v.replace(v.trim(), map.get(v.trim())!) : v
      if (next !== v) out.push({ r, c: info.col, v: next })
    }
  }
  return out
}

/**
 * 枚举对话框保存时找出改名：同一个枚举、同一个位置的值名字变了，且旧名字不在新列表里（不是换位置）
 */
export function findEnumRenames(before: TableSchema['enums'], after: TableSchema['enums']): EnumRename[] {
  const out: EnumRename[] = []
  for (const [name, e] of Object.entries(after)) {
    const old = before[name]
    if (!old) continue
    const now = new Set(e.values.map((v) => v.name))
    old.values.forEach((v, i) => {
      const to = e.values[i]?.name
      if (to && v.name && to !== v.name && !now.has(v.name)) out.push({ enum: name, from: v.name, to })
    })
  }
  return out
}
