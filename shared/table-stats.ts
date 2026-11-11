/**
 * 一列的统计和规则推断（不用 AI）：唯一值、空值、出现最多的值、最小最大；按数据建议范围、枚举、必填。
 * 纯函数，结果确定；大表只看前 STATS_MAX 行（标「抽样」）
 */
import { t } from './i18n.ts'
import { colKey, type TableColumn, type TableSchema } from './tables.ts'
import type { ColInfo } from './table-struct.ts'

/** 统计最多看这么多行：再多先抽前面这些，标「抽样」 */
export const STATS_MAX = 50_000
/** 只有这么几种值（且行数够多）时建议做成枚举 */
const ENUM_MAX = 12

export interface ColumnStats {
  /** 看了几行（数据行） */
  rows: number
  /** 只看了前 STATS_MAX 行 */
  sampled: boolean
  empty: number
  unique: number
  /** 出现最多的值和次数（最多 10 个） */
  top: [string, number][]
  /** 非空的值都是数字时的最小最大 */
  min?: number
  max?: number
  /** 非空的值都是整数 */
  ints: boolean
  /** 非空的值都是数字 */
  nums: boolean
  /** 值的种类不多（不超过 ENUM_MAX）时全部列出来（建议枚举用） */
  distinct?: string[]
}

/** 数组列按分隔符拆开，每一项各算一次 */
export function columnStats(rows: string[][], from: number, col: number, sep?: string): ColumnStats {
  const end = Math.min(rows.length, from + STATS_MAX)
  const count = new Map<string, number>()
  let empty = 0
  let nums = true
  let ints = true
  let min = Infinity
  let max = -Infinity
  let seen = 0
  for (let r = from; r < end; r++) {
    const raw = (rows[r]?.[col] ?? '').trim()
    if (!raw) {
      empty++
      continue
    }
    for (const v of sep ? raw.split(sep).map((x) => x.trim()) : [raw]) {
      if (!v) continue
      seen++
      count.set(v, (count.get(v) ?? 0) + 1)
      const n = Number(v)
      if (!Number.isFinite(n)) nums = ints = false
      else {
        if (!Number.isInteger(n)) ints = false
        if (n < min) min = n
        if (n > max) max = n
      }
    }
  }
  const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const hasNum = nums && seen > 0
  return {
    rows: end - from,
    sampled: rows.length > end,
    empty,
    unique: count.size,
    top,
    ...(hasNum ? { min, max } : {}),
    nums: hasNum,
    ints: hasNum && ints,
    ...(count.size <= ENUM_MAX ? { distinct: [...count.keys()].sort((a, b) => a.localeCompare(b)) } : {}),
  }
}

/** 一条建议：说明 + 点了以后结构文件怎么改 */
export interface RuleHint {
  id: 'range' | 'enum' | 'required' | 'int'
  label: string
  apply: (s: TableSchema) => TableSchema
}

/** 按统计结果给建议；已经设过的规则不再建议 */
export function inferRules(st: ColumnStats, info: ColInfo, file: string): RuleHint[] {
  if (!info.field || info.remark) return []
  const key = colKey(file, '*', info.field)
  const patch =
    (p: TableColumn) =>
    (s: TableSchema): TableSchema => ({ ...s, columns: { ...s.columns, [key]: { ...s.columns[key], ...p } } })
  const out: RuleHint[] = []
  const filled = st.rows - st.empty
  if (st.nums && st.min !== undefined && st.max !== undefined && info.min === undefined && info.max === undefined)
    out.push({
      id: 'range',
      label: t('全是 {a}~{b} 的{kind}，建议设范围 {a}~{b}', {
        a: st.min,
        b: st.max,
        kind: st.ints ? t('整数') : t('数字'),
      }),
      apply: patch({ min: st.min, max: st.max }),
    })
  if (st.ints && info.kind === 'string')
    out.push({ id: 'int', label: t('全是整数，建议把类型设成 int32'), apply: patch({ type: 'int32' }) })
  if (!st.nums && !info.enumName && !info.ref && st.unique >= 2 && st.unique <= ENUM_MAX && filled >= st.unique * 3) {
    const name = info.field
    out.push({
      id: 'enum',
      label: t('只有 {n} 种值，建议做成枚举 {name}', { n: st.unique, name }),
      apply: (s) => {
        const have = s.enums[name]
        const values = have ? have.values : (st.distinct ?? []).map((v) => ({ name: v }))
        return patch({ enum: name })({ ...s, enums: { ...s.enums, [name]: { ...have, values } } })
      },
    })
  }
  if (!st.empty && st.rows >= 5 && !info.required)
    out.push({ id: 'required', label: t('没有空着的，建议设成必填'), apply: patch({ required: true }) })
  return out
}
