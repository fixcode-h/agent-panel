/**
 * 表格页的导出（CSV / JSON，给程序或别的工具用）和从 CSV 粘贴导入（追加新行，或按主键更新已有的行）。
 * 纯函数，导入的结果交给页面当一次改动（一次撤销），看过再保存
 */
import type { CellSet, RowOp } from './table-edit.ts'
import type { ColInfo } from './table-struct.ts'
import { parseCsv, writeCsv } from './csv.ts'

/** 整张表（含表头）存成 CSV：带 BOM，Excel / WPS 直接打开不乱码 */
export const sheetCsv = (rows: string[][]) => writeCsv(rows, { delimiter: ',', eol: 'crlf', bom: true })

const NUM = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/
function typed(v: string, info: ColInfo): unknown {
  const one = (x: string): unknown => {
    const s = x.trim()
    if ((info.kind === 'int' || info.kind === 'uint' || info.kind === 'float') && NUM.test(s)) return Number(s)
    if (info.kind === 'bool' && /^(true|false|1|0)$/i.test(s)) return /^(true|1)$/i.test(s)
    return x
  }
  if (info.list) return v === '' ? [] : v.split(info.sep).map(one)
  return one(v)
}

/**
 * 数据行存成 JSON：每行一个对象，键是字段名（没字段名的备注列不要），
 * 数字 / 布尔列按类型转，数组列拆成数组；没有表头时每行是一个字符串数组
 */
export function sheetJson(rows: string[][], from: number, infos: ColInfo[], order?: number[]): string {
  const cols = infos.filter((i) => i.field && !i.remark)
  const idx = order ?? Array.from({ length: Math.max(0, rows.length - from) }, (_, i) => from + i)
  const data = idx
    .map((r) => rows[r] ?? [])
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => (cols.length ? Object.fromEntries(cols.map((i) => [i.field, typed(r[i.col] ?? '', i)])) : r))
  return JSON.stringify(data, null, 2) + '\n'
}

export interface ImportPlan {
  /** 追加的行（已经按这张表的列排好） */
  add: string[][]
  /** 按主键更新的格子 */
  cells: CellSet[]
  /** 主键已有、值没变的行 */
  same: number
  /** 粘贴的第一行是字段名时按名字对列；对不上的列名 */
  unknown: string[]
  /** 按字段名对列（否则按位置） */
  byName: boolean
}

/**
 * 粘贴的 CSV / TSV 怎么进这张表：第一行有一半以上是这张表的字段名就当表头、按字段名对列，否则按位置。
 * 有主键列时，主键已有的行改成粘贴的值（只改粘贴里有的列），新主键追加到末尾；没主键全部追加
 */
export function importPlan(
  rows: string[][],
  from: number,
  infos: ColInfo[],
  keyCol: number,
  text: string,
  upsert: boolean,
): ImportPlan {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''))
  const names = infos.map((i) => i.field)
  const head = grid[0] ?? []
  const hits = head.filter((h) => h.trim() && names.includes(h.trim())).length
  const byName = hits > 0 && hits * 2 >= head.filter((h) => h.trim()).length
  const map = byName ? head.map((h) => names.indexOf(h.trim())) : head.map((_, i) => i)
  const unknown = byName ? head.filter((h, i) => h.trim() && map[i] < 0) : []
  const body = byName ? grid.slice(1) : grid
  const width = Math.max(infos.length, ...body.map((r) => (byName ? 0 : r.length)))
  const kIn = keyCol >= 0 ? map.indexOf(keyCol) : -1
  const where = new Map<string, number>()
  if (upsert && kIn >= 0)
    for (let r = from; r < rows.length; r++) {
      const k = (rows[r]?.[keyCol] ?? '').trim()
      if (k && !where.has(k)) where.set(k, r)
    }
  const add: string[][] = []
  const cells: CellSet[] = []
  let same = 0
  for (const line of body) {
    const k = kIn >= 0 ? (line[kIn] ?? '').trim() : ''
    const at = k ? where.get(k) : undefined
    if (at !== undefined) {
      const before = cells.length
      line.forEach((v, i) => {
        const c = map[i]
        if (c >= 0 && (rows[at]?.[c] ?? '') !== v) cells.push({ r: at, c, v })
      })
      if (cells.length === before) same++
      continue
    }
    const row = Array.from({ length: width }, () => '')
    line.forEach((v, i) => map[i] >= 0 && (row[map[i]] = v))
    add.push(row)
    // 同一次粘贴里主键重复：后面的当更新前面刚加的那行没意义，照样追加，检查会标出重复
  }
  return { add, cells, same, unknown, byName }
}

/** 导入要做的改动：末尾插入新行 + 新行和更新的格子（交给 rowOpWithCells，一次撤销） */
export function importEdit(rowsLen: number, plan: ImportPlan): { op: RowOp | null; cells: CellSet[] } {
  const op = plan.add.length ? { at: rowsLen, n: plan.add.length } : null
  const cells = [...plan.cells]
  plan.add.forEach((row, i) => row.forEach((v, c) => v !== '' && cells.push({ r: rowsLen + i, c, v })))
  return { op, cells }
}
