/**
 * 批量修改选中的格子：加减乘除一个数、加前缀后缀、正则替换、按序列重新编号。
 * 纯函数，只返回值真的变了的格子；表格页先预览，确认后一次放进表格（一步撤销）
 */
import type { CellSet } from './table-edit.ts'

export type BatchOp =
  | { kind: 'math'; fn: '+' | '-' | '*' | '/'; n: number }
  | { kind: 'affix'; prefix: string; suffix: string }
  | { kind: 'regex'; find: string; replace: string; flags?: string }
  | { kind: 'renumber'; start: number; step: number }

/** 浮点误差收一下：0.1 * 3 显示成 0.3，不是 0.30000000000000004 */
const tidy = (n: number) => String(Number(n.toPrecision(12)))

/**
 * cells 按显示顺序（重新编号按这个顺序）；数字运算跳过不是数字的、空的格子；
 * 正则写错时抛出原因（界面显示出来）
 */
export function batchEdit(rows: string[][], cells: { r: number; c: number }[], op: BatchOp): CellSet[] {
  const re = op.kind === 'regex' && op.find ? new RegExp(op.find, op.flags ?? 'g') : null
  const out: CellSet[] = []
  cells.forEach(({ r, c }, i) => {
    const v = rows[r]?.[c] ?? ''
    let next = v
    if (op.kind === 'math') {
      const x = Number(v)
      if (!v.trim() || !Number.isFinite(x)) return
      if (op.fn === '/' && op.n === 0) return
      next = tidy(op.fn === '+' ? x + op.n : op.fn === '-' ? x - op.n : op.fn === '*' ? x * op.n : x / op.n)
    } else if (op.kind === 'affix') {
      if (!v) return
      next = `${op.prefix}${v}${op.suffix}`
    } else if (op.kind === 'regex') {
      if (!re) return
      next = v.replace(re, op.replace)
    } else next = tidy(op.start + op.step * i)
    if (next !== v) out.push({ r, c, v: next })
  })
  return out
}
