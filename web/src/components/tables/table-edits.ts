/**
 * 表格页一个文件的改动：每张表现在的样子（rows）和做过的行操作（ops），撤销 / 重做按「改之前那张表的快照」记。
 * 快照是浅拷贝：只复制改到的那几行，一万行的表改一格也只多一个外层数组。全是纯函数，页面拿 state 存。
 */
import { applyRowOps, changedCells, type CellSet, type RowOp, type SheetEdit } from '@shared/table-edit'
import type { SheetData } from '@shared/files'

export interface SheetState {
  rows: string[][]
  ops: RowOp[]
}

export interface Edits {
  sheets: Record<string, SheetState>
  undo: { sheet: string; before: SheetState | undefined }[]
  redo: { sheet: string; before: SheetState | undefined }[]
}

/** 撤销最多记这么多步 */
const MAX_UNDO = 200

export const noEdits = (): Edits => ({ sheets: {}, undo: [], redo: [] })

export const rowsOf = (e: Edits | undefined, s: SheetData) => e?.sheets[s.name]?.rows ?? s.rows

function commit(e: Edits, sheet: string, next: SheetState): Edits {
  const undo = [...e.undo, { sheet, before: e.sheets[sheet] }].slice(-MAX_UNDO)
  return { sheets: { ...e.sheets, [sheet]: next }, undo, redo: [] }
}

/** 改格子；值没变的格子跳过，一个都没变时原样返回（不进撤销） */
export function setCellsIn(e: Edits, s: SheetData, cells: CellSet[]): Edits {
  const cur = e.sheets[s.name] ?? { rows: s.rows, ops: [] }
  const real = cells.filter(({ r, c, v }) => (cur.rows[r]?.[c] ?? '') !== v)
  if (!real.length) return e
  const rows = [...cur.rows]
  const touched = new Set<number>()
  for (const { r, c, v } of real) {
    while (rows.length <= r) rows.push([])
    if (!touched.has(r)) {
      rows[r] = [...rows[r]]
      touched.add(r)
    }
    const row = rows[r]
    while (row.length <= c) row.push('')
    row[c] = v
  }
  return commit(e, s.name, { rows, ops: cur.ops })
}

/** 插行（n > 0）或删行（n < 0） */
export function rowOpIn(e: Edits, s: SheetData, op: RowOp): Edits {
  const cur = e.sheets[s.name] ?? { rows: s.rows, ops: [] }
  return commit(e, s.name, { rows: applyRowOps(cur.rows, [op]), ops: [...cur.ops, op] })
}

export function undoIn(e: Edits): Edits {
  const last = e.undo[e.undo.length - 1]
  if (!last) return e
  const sheets = { ...e.sheets }
  const now = sheets[last.sheet]
  if (last.before) sheets[last.sheet] = last.before
  else delete sheets[last.sheet]
  return { sheets, undo: e.undo.slice(0, -1), redo: [...e.redo, { sheet: last.sheet, before: now }] }
}

export function redoIn(e: Edits): Edits {
  const last = e.redo[e.redo.length - 1]
  if (!last) return e
  const sheets = { ...e.sheets }
  const now = sheets[last.sheet]
  if (last.before) sheets[last.sheet] = last.before
  else delete sheets[last.sheet]
  return { sheets, undo: [...e.undo, { sheet: last.sheet, before: now }], redo: e.redo.slice(0, -1) }
}

/** 要保存的：每张改过的表的行操作和改了的格子（改了又改回去的不算） */
export function pendingOf(e: Edits | undefined, sheets: SheetData[]): SheetEdit[] {
  if (!e) return []
  const out: SheetEdit[] = []
  for (const s of sheets) {
    const st = e.sheets[s.name]
    if (!st) continue
    const cells = changedCells(s.rows, st.ops, st.rows)
    if (cells.length || st.ops.length) out.push({ name: s.name, rows: st.ops, cells })
  }
  return out
}

/** 改过的格子：「行:列」 */
export function dirtyCells(e: Edits | undefined, s: SheetData): Set<string> {
  const st = e?.sheets[s.name]
  if (!st) return new Set()
  return new Set(changedCells(s.rows, st.ops, st.rows).map((c) => `${c.r}:${c.c}`))
}
