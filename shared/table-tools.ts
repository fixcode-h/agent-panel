/**
 * 表格页的批量编辑：新增行自动编号、复制行时主键 +1、向下填充（复制或按步长递增）、查找替换。
 * 全是纯函数，算出要改的格子（CellSet），由页面一次提交（一次撤销）。
 */
import type { CellSet } from './table-edit.ts'

const INT = /^-?\d+$/

/** 主键列里最大的整数 + 1；没有整数主键时返回空（不编号） */
export function nextKey(rows: string[][], from: number, keyCol: number): string {
  let max: bigint | null = null
  for (let r = from; r < rows.length; r++) {
    const v = rows[r]?.[keyCol]?.trim() ?? ''
    if (!INT.test(v)) continue
    const n = BigInt(v)
    if (max === null || n > max) max = n
  }
  return max === null ? '' : String(max + 1n)
}

/**
 * 向下填充：rows 是选中的几行（按显示顺序的行号），cols 是选中的列。
 * series=false 时每列都复制第一行；series=true 时第一、二行都是整数就按它们的差递增，只有第一行是整数就每行 +1，不是数字的照样复制
 */
export function fillDown(grid: string[][], rows: number[], cols: number[], series = false): CellSet[] {
  if (rows.length < 2) return []
  const out: CellSet[] = []
  for (const c of cols) {
    const first = grid[rows[0]]?.[c] ?? ''
    const second = grid[rows[1]]?.[c] ?? ''
    let step: bigint | null = null
    if (series && INT.test(first.trim()))
      step = INT.test(second.trim()) && rows.length > 2 ? BigInt(second.trim()) - BigInt(first.trim()) : 1n
    // 有步长且用了前两行定步长时，从第三行开始填；否则从第二行开始
    const startAt = series && step !== null && rows.length > 2 && INT.test(second.trim()) ? 2 : 1
    for (let i = startAt; i < rows.length; i++) {
      const v = step === null ? first : String(BigInt(first.trim()) + step * BigInt(i))
      out.push({ r: rows[i], c, v })
    }
  }
  return out
}

export interface FindOpts {
  /** 区分大小写 */
  caseSensitive?: boolean
  /** 整格匹配 */
  whole?: boolean
  /** 按正则找（替换里可以用 $1） */
  regex?: boolean
}

/** 把「找什么」编成正则；写错的正则抛出原因 */
export function findRe(find: string, o: FindOpts): RegExp {
  const body = o.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(o.whole ? `^(?:${body})$` : body, o.caseSensitive ? 'g' : 'gi')
}

/** 查找替换：在给定的行、列里找，返回每处要改成什么（预览和提交共用） */
export function findReplace(
  grid: string[][],
  rows: number[],
  cols: number[],
  find: string,
  replace: string,
  o: FindOpts = {},
  limit = 50_000,
): { cells: (CellSet & { old: string })[]; truncated: boolean } {
  const cells: (CellSet & { old: string })[] = []
  if (!find) return { cells, truncated: false }
  const re = findRe(find, o)
  for (const r of rows)
    for (const c of cols) {
      const old = grid[r]?.[c] ?? ''
      if (!old) continue
      re.lastIndex = 0
      if (!re.test(old)) continue
      re.lastIndex = 0
      const v = o.regex ? old.replace(re, replace) : old.replace(re, () => replace)
      if (v === old) continue
      cells.push({ r, c, v, old })
      if (cells.length >= limit) return { cells, truncated: true }
    }
  return { cells, truncated: false }
}
