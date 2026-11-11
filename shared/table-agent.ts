/**
 * 给 Agent 用的表格读写（app 动作 table.query / table.edit，见 server/app-actions/tables.ts）：
 * 按字段名和主键说话，不用管第几行第几列；改动走和表格页同一个原地写入器（只改这些格子，文件格式不变），
 * 写之前按项目的表格结构检查一遍。这样 Agent 不用再拿 openpyxl 之类整本重写 xlsx（会丢样式、改格式）。
 */
import { z } from 'zod'
import type { SheetHeader } from './sheet-header.ts'
import { applyRowOps, setCells, type CellSet, type RowOp, type SheetEdit } from './table-edit.ts'

export const TableQueryInput = z.object({
  path: z.string().trim().min(1).max(600).describe('表格文件相对项目目录的路径，见 table.list'),
  sheet: z.string().max(200).optional().describe('工作表名，不写是第一张'),
  where: z
    .record(z.string(), z.string())
    .optional()
    .describe('按字段筛：{ "字段名": "值" }，值完全相同才算；值以 ~ 开头时按包含算，例如 { "DisplayName": "~穿衣镜" }'),
  text: z.string().max(200).optional().describe('任何一格包含这段字的行'),
  fields: z.array(z.string()).max(200).optional().describe('只返回这些字段，不写返回全部'),
  limit: z.number().int().min(1).max(500).default(50),
})
export type TableQueryInput = z.infer<typeof TableQueryInput>

const Row = z.record(z.string(), z.string())
export const TableEditInput = z.object({
  path: z.string().trim().min(1).max(600),
  sheet: z.string().max(200).optional(),
  set: z
    .array(
      z.object({
        key: z.string().optional().describe('主键的值（主键字段见 table.query 返回的 key）'),
        row: z.number().int().min(1).optional().describe('Excel 里的行号（从 1 数），没有主键时用'),
        values: Row.describe('{ "字段名": "新值" }'),
      }),
    )
    .max(2000)
    .default([])
    .describe('改已有的行'),
  add: z.array(Row).max(2000).default([]).describe('在末尾加的行：{ "字段名": "值" }，没写的字段留空'),
  remove: z
    .array(z.union([z.string(), z.number().int().min(1)]))
    .max(2000)
    .default([])
    .describe('删掉的行：主键的值，或 Excel 行号'),
  force: z.boolean().default(false).describe('结构检查有问题也照样写（只在用户明确要求时用）'),
})
export type TableEditInput = z.infer<typeof TableEditInput>

/** 字段名那一行（去掉首尾空格） */
export function fieldNames(rows: string[][], header: SheetHeader) {
  const i = header.roles.indexOf('name')
  return i < 0 ? [] : (rows[header.start + i] ?? []).map((x) => x.trim())
}

/** 没有字段名时用列字母当字段名：A、B…… */
export function colLetters(c: number) {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

function columns(rows: string[][], header: SheetHeader) {
  const names = fieldNames(rows, header)
  const width = rows.reduce((m, r) => Math.max(m, r.length), names.length)
  return Array.from({ length: width }, (_, c) => names[c] || colLetters(c))
}

const hit = (v: string, want: string) => (want.startsWith('~') ? v.includes(want.slice(1)) : v.trim() === want.trim())

export function queryRows(rows: string[][], header: SheetHeader, key: string, q: TableQueryInput) {
  const cols = columns(rows, header)
  const from = header.start + header.roles.length
  for (const f of [...Object.keys(q.where ?? {}), ...(q.fields ?? [])])
    if (!cols.includes(f)) throw new Error(`没有字段「${f}」。这张表的字段：${cols.join('、')}`)
  const pick = q.fields?.length ? q.fields : cols
  const out: { row: number; values: Record<string, string> }[] = []
  let total = 0
  for (let r = from; r < rows.length; r++) {
    const row = rows[r] ?? []
    if (!row.some((x) => x)) continue
    if (q.where && Object.entries(q.where).some(([f, v]) => !hit(row[cols.indexOf(f)] ?? '', v))) continue
    if (q.text && !row.some((x) => x.includes(q.text!))) continue
    total++
    if (out.length < q.limit)
      out.push({ row: r + 1, values: Object.fromEntries(pick.map((f) => [f, row[cols.indexOf(f)] ?? ''])) })
  }
  return { fields: cols, key: cols.includes(key) ? key : '', dataFrom: from + 1, total, rows: out }
}

/**
 * 把 Agent 的改动换成表格页同样的「行操作 + 格子」：先删行（从下往上）、再在末尾加行、最后改格子。
 * 找不到的主键 / 字段直接报错，不猜
 */
export function planEdit(
  rows: string[][],
  header: SheetHeader,
  key: string,
  sheet: string,
  e: TableEditInput,
): { edit: SheetEdit; after: string[][]; touched: CellSet[]; removed: number } {
  const cols = columns(rows, header)
  const from = header.start + header.roles.length
  const kc = cols.indexOf(key)
  const col = (f: string) => {
    const c = cols.indexOf(f)
    if (c < 0) throw new Error(`没有字段「${f}」。这张表的字段：${cols.join('、')}`)
    return c
  }
  const rowOf = (k: string | number | undefined, r?: number) => {
    if (r !== undefined || typeof k === 'number') {
      const n = (r ?? (k as number)) - 1
      if (n < from || n >= rows.length) throw new Error(`第 ${n + 1} 行不是数据行（数据从第 ${from + 1} 行开始）`)
      return n
    }
    if (kc < 0) throw new Error('这张表没有主键字段，按 row（Excel 行号）指定行')
    const want = String(k ?? '').trim()
    for (let i = from; i < rows.length; i++) if ((rows[i]?.[kc] ?? '').trim() === want) return i
    throw new Error(`主键 ${key}=${want} 的行不存在`)
  }
  // 删行：按删之前的行号定，从下往上删，行号不互相影响
  const del = [...new Set(e.remove.map((k) => rowOf(k)))].sort((a, b) => b - a)
  const ops: RowOp[] = del.map((at) => ({ at, n: -1 }))
  // 改格子的行号也按删之前的定，再换算到删之后
  const shift = (r: number) => r - del.filter((d) => d < r).length
  const cells: CellSet[] = []
  for (const s of e.set) {
    const r = rowOf(s.key, s.row)
    if (del.includes(r)) throw new Error(`第 ${r + 1} 行同时要改又要删`)
    for (const [f, v] of Object.entries(s.values)) cells.push({ r: shift(r), c: col(f), v })
  }
  let end = rows.length - del.length
  // 末尾的空行不算：加在最后一行有内容的行后面
  const base = applyRowOps(rows, ops)
  while (end > from && !(base[end - 1] ?? []).some((x) => x)) end--
  if (e.add.length) ops.push({ at: end, n: e.add.length })
  e.add.forEach((values, i) => {
    for (const [f, v] of Object.entries(values)) cells.push({ r: end + i, c: col(f), v })
  })
  const after = setCells(applyRowOps(rows, ops), cells)
  return { edit: { name: sheet, rows: ops, cells }, after, touched: cells, removed: del.length }
}
