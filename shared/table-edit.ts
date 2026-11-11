/**
 * 表格页的改动：页面上改格子、增删行，保存时发给服务端的是「行操作 + 改了的格子」，
 * 服务端在磁盘上的文件上照做一遍、写回后重新解析，和这里算出来的结果逐格对上才算保存成功。
 * 页面和服务端用同一份 applyRowOps / setCells，两边算出来的「应该是什么样」一定一致。
 */
import { z } from 'zod'

/** 一个行操作：在 at 处插入 n 行（n > 0）或从 at 起删掉 -n 行（n < 0） */
export const RowOp = z.object({
  at: z.number().int().min(0).max(1_048_575),
  n: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .refine((n) => n !== 0),
})
export type RowOp = z.infer<typeof RowOp>

export const CellSet = z.object({
  r: z.number().int().min(0).max(1_048_575),
  c: z.number().int().min(0).max(16_383),
  v: z.string().max(32_767),
})
export type CellSet = z.infer<typeof CellSet>

export const SheetEdit = z.object({
  name: z.string().max(200),
  /** 先按顺序做行操作，格子的行号是做完行操作之后的 */
  rows: z.array(RowOp).max(1000).default([]),
  cells: z.array(CellSet).max(200_000).default([]),
})
export type SheetEdit = z.infer<typeof SheetEdit>

export const TableSave = z.object({
  path: z.string().min(1).max(600),
  /** 打开时文件的修改时间：对不上说明外面改过 */
  mtime: z.string().max(40),
  sheets: z.array(SheetEdit).min(1).max(100),
  /** 外面改过也照样把这些格子写进去（只改格子、没有行操作时才允许） */
  force: z.boolean().optional(),
})
export type TableSave = z.infer<typeof TableSave>

/** 做行操作（不改原数组）：插入的是空行 */
export function applyRowOps(rows: string[][], ops: RowOp[]): string[][] {
  const out = rows.map((r) => [...r])
  for (const op of ops) {
    if (op.n > 0) {
      while (out.length < op.at) out.push([])
      out.splice(op.at, 0, ...Array.from({ length: op.n }, () => [] as string[]))
    } else out.splice(op.at, -op.n)
  }
  return out
}

/** 把格子写进去（改原数组） */
export function setCells(rows: string[][], cells: CellSet[]) {
  for (const { r, c, v } of cells) {
    while (rows.length <= r) rows.push([])
    const row = rows[r]
    while (row.length <= c) row.push('')
    row[c] = v
  }
  return rows
}

/** 去掉每行末尾的空格子、表末尾的空行：解析出来的表不带这些，比较前两边都这样收一下 */
export function trimGrid(rows: string[][]): string[][] {
  const out = rows.map((r) => {
    let n = r.length
    while (n > 0 && !r[n - 1]) n--
    return r.slice(0, n)
  })
  while (out.length && !out[out.length - 1].length) out.pop()
  return out
}

/** 两张表收过之后是不是一样；不一样时给出第一处不同（报错时说清楚哪一格） */
export function gridDiff(a: string[][], b: string[][]): { r: number; c: number; a: string; b: string } | null {
  const x = trimGrid(a)
  const y = trimGrid(b)
  for (let r = 0; r < Math.max(x.length, y.length); r++) {
    const ra = x[r] ?? []
    const rb = y[r] ?? []
    for (let c = 0; c < Math.max(ra.length, rb.length); c++)
      if ((ra[c] ?? '') !== (rb[c] ?? '')) return { r, c, a: ra[c] ?? '', b: rb[c] ?? '' }
  }
  return null
}

/** 页面上：原表做完行操作后和现在的表比，哪些格子变了 */
export function changedCells(base: string[][], ops: RowOp[], now: string[][]): CellSet[] {
  const before = applyRowOps(base, ops)
  const out: CellSet[] = []
  for (let r = 0; r < Math.max(before.length, now.length); r++) {
    const a = before[r] ?? []
    const b = now[r] ?? []
    for (let c = 0; c < Math.max(a.length, b.length); c++)
      if ((a[c] ?? '') !== (b[c] ?? '')) out.push({ r, c, v: b[c] ?? '' })
  }
  return out
}

/** 一格的名字：第 0 行第 2 列 → C1 */
export function cellRef(r: number, c: number) {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return `${s}${r + 1}`
}

/** 粘贴：从剪贴板的 TSV（Excel / WPS 复制出来的就是）拆成行列；Excel 复制时末尾多一个换行 */
export function parseClip(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!t) return []
  // 带引号的多行格子（Excel 复制有换行的格子时会加引号）
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"' && cell === '') q = true
    else if (ch === '\t') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/** 复制：选中的一块写成 TSV，有换行、制表符、引号的格子加引号 */
export function toClip(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t')).join('\n')
}
