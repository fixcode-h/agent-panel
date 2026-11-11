/**
 * 表格的列筛选和排序（纯函数）：只决定显示哪些数据行、按什么顺序，不改表格内容。
 * 表头行不参与，永远显示在最上面；筛选多列时取交集。
 */

/** 条件筛选的比较方式 */
export const FILTER_OPS = ['eq', 'ne', 'gt', 'lt', 'between', 'contains', 'empty', 'notEmpty'] as const
export type FilterOp = (typeof FILTER_OPS)[number]

export interface ColFilter {
  /** 只显示这些值（按格子原文比）；不设就是不按值筛 */
  values?: string[]
  /** 再按条件筛 */
  cond?: { op: FilterOp; a?: string; b?: string }
}

export type ColFilters = Record<number, ColFilter>
export interface SheetSort {
  col: number
  desc: boolean
}

/** 值列表最多列这么多个：再多用户也不会一个个勾，用搜索和条件 */
export const VALUE_LIST_MAX = 500

const num = (s: string) => (s.trim() === '' ? NaN : Number(s))

/** 一列的去重值和出现次数，按次数多到少、同次数按值排 */
export function distinctValues(rows: string[][], from: number, col: number) {
  const count = new Map<string, number>()
  for (let r = from; r < rows.length; r++) {
    const v = rows[r][col] ?? ''
    count.set(v, (count.get(v) ?? 0) + 1)
  }
  const list = [...count].map(([value, n]) => ({ value, count: n }))
  list.sort((a, b) => b.count - a.count || compareCells(a.value, b.value))
  return { list: list.slice(0, VALUE_LIST_MAX), total: list.length }
}

/** 一列（非空格子）是不是全是数字：是的话条件筛选给大于 / 小于 / 介于 */
export function isNumericColumn(rows: string[][], from: number, col: number) {
  let seen = 0
  for (let r = from; r < rows.length; r++) {
    const v = rows[r][col]
    if (!v || !v.trim()) continue
    if (Number.isNaN(Number(v))) return false
    seen++
  }
  return seen > 0
}

/** 两格比大小：都是数字按数字，否则按文字（文字里的数字片段按大小比，item2 排在 item10 前面） */
export function compareCells(a: string, b: string) {
  const x = num(a)
  const y = num(b)
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y
  // 空格子排在最后
  if (!a) return b ? 1 : 0
  if (!b) return -1
  return a.localeCompare(b, undefined, { numeric: true })
}

function condOk(v: string, c: NonNullable<ColFilter['cond']>) {
  const { op } = c
  if (op === 'empty') return !v.trim()
  if (op === 'notEmpty') return !!v.trim()
  const a = c.a ?? ''
  if (op === 'contains') return v.toLowerCase().includes(a.toLowerCase())
  const n = num(v)
  const na = num(a)
  // 两边都是数字按数字比，否则按文字
  const cmp = !Number.isNaN(n) && !Number.isNaN(na) ? n - na : v.localeCompare(a)
  if (op === 'eq') return cmp === 0
  if (op === 'ne') return cmp !== 0
  if (op === 'gt') return cmp > 0
  if (op === 'lt') return cmp < 0
  // 介于：两端都包含，填反了也认
  const nb = num(c.b ?? '')
  if (Number.isNaN(n) || Number.isNaN(na) || Number.isNaN(nb)) return false
  return n >= Math.min(na, nb) && n <= Math.max(na, nb)
}

/** 条件是否填完整（没填完的条件当没设） */
export function condReady(c: ColFilter['cond']) {
  if (!c) return false
  if (c.op === 'empty' || c.op === 'notEmpty') return true
  if (c.op === 'between') return !!c.a?.trim() && !!c.b?.trim()
  return !!c.a?.trim()
}

/** 这一列的筛选是否真的在起作用 */
export const filterActive = (f: ColFilter | undefined) => !!f && (!!f.values || condReady(f.cond))

/** 要显示的数据行（行号，从 from 开始），筛选后再排序；没有筛选和排序时就是原顺序 */
export function visibleRows(rows: string[][], from: number, filters: ColFilters, sort: SheetSort | null): number[] {
  const active = Object.entries(filters)
    .filter(([, f]) => filterActive(f))
    .map(([c, f]) => ({ col: Number(c), values: f.values && new Set(f.values), cond: condReady(f.cond) && f.cond }))
  const out: number[] = []
  for (let r = from; r < rows.length; r++) {
    const row = rows[r]
    let ok = true
    for (const f of active) {
      const v = row[f.col] ?? ''
      if ((f.values && !f.values.has(v)) || (f.cond && !condOk(v, f.cond))) {
        ok = false
        break
      }
    }
    if (ok) out.push(r)
  }
  if (sort) {
    const { col, desc } = sort
    // 稳定排序：值相同保持表里原来的先后
    out.sort((a, b) => {
      const c = compareCells(rows[a][col] ?? '', rows[b][col] ?? '')
      return (desc ? -c : c) || a - b
    })
  }
  return out
}
