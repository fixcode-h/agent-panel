/**
 * 两版表格的格子级差异：版本差异（旧版本 ↔ 本地）和跨项目对比用同一份。
 * 列按字段名对齐（两边列顺序不同、加了列也不错位），没有字段名时按位置；
 * 行有主键时按主键对齐（中间插一行不会让下面整片都算改动），没有主键时按整行内容做最长公共子序列，
 * 同一段里删掉几行又加了几行的按顺序配成「改」。
 */

export type DiffKind = 'same' | 'mod' | 'add' | 'del'

export interface DiffRow {
  kind: DiffKind
  /** 旧表里的行号（从 0 数，含表头行）；新增的行没有 */
  a?: number
  /** 新表里的行号；删掉的行没有 */
  b?: number
  /** 改了的列（按新表的列号）；只有 mod 有 */
  cols?: number[]
}

export interface SheetDiff {
  rows: DiffRow[]
  /** 新表的第 c 列对应旧表的哪一列（-1 是新加的列） */
  colMap: number[]
  /** 按什么对齐：主键字段名，空是按行内容 */
  key: string
  addedCols: string[]
  removedCols: string[]
  /** 表头行（字段名以外的类型、注释……）变了的列 */
  headerChanged: string[]
  stats: { mod: number; add: number; del: number; cells: number }
}

export interface DiffSide {
  rows: string[][]
  /** 数据从第几行开始（表头行数） */
  from: number
  /** 字段名那一行；没有就按位置对齐列 */
  names?: string[]
}

/** 行内容做 LCS 的上限（格子数），超过时退成按顺序配对：一万行的表不在浏览器里卡住 */
const LCS_MAX = 4_000_000

const cell = (rows: string[][], r: number, c: number) => (c < 0 ? '' : (rows[r]?.[c] ?? ''))

function mapCols(a: DiffSide, b: DiffSide) {
  const width = (s: DiffSide) => s.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const wa = width(a)
  const wb = width(b)
  const na = (a.names ?? []).map((x) => x.trim())
  const nb = (b.names ?? []).map((x) => x.trim())
  const byName = na.some(Boolean) && nb.some(Boolean)
  const colMap: number[] = []
  for (let c = 0; c < wb; c++) {
    if (!byName) colMap.push(c < wa ? c : -1)
    else colMap.push(nb[c] ? na.indexOf(nb[c]) : c < wa && !na[c] ? c : -1)
  }
  const used = new Set(colMap)
  const label = (names: string[], c: number) => names[c] || colLabel(c)
  const addedCols = colMap.flatMap((m, c) => (m < 0 ? [label(nb, c)] : []))
  const removedCols: string[] = []
  for (let c = 0; c < wa; c++) if (!used.has(c) && (na[c] || a.rows.some((r) => r[c]))) removedCols.push(label(na, c))
  return { colMap, byName, na, nb, wb, addedCols, removedCols }
}

function colLabel(c: number) {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** 主键 → 行号；有重复或空主键时不能按主键对齐 */
function keyIndex(s: DiffSide, col: number) {
  const m = new Map<string, number>()
  for (let r = s.from; r < s.rows.length; r++) {
    const k = cell(s.rows, r, col).trim()
    if (!k) {
      if (s.rows[r]?.some((x) => x)) return null
      continue
    }
    if (m.has(k)) return null
    m.set(k, r)
  }
  return m
}

/** 最长公共子序列：返回配上的 [旧行, 新行] */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  if (n * m > LCS_MAX) {
    // 太大：先按相同内容贪心往后配
    const out: [number, number][] = []
    let j = 0
    for (let i = 0; i < n && j < m; i++) {
      const k = b.indexOf(a[i], j)
      if (k >= 0 && k - j < 50) {
        out.push([i, k])
        j = k + 1
      }
    }
    return out
  }
  const dp = new Uint32Array((n + 1) * (m + 1))
  const w = m + 1
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
    else j++
  }
  return out
}

export function diffSheet(a: DiffSide, b: DiffSide, key = ''): SheetDiff {
  const cols = mapCols(a, b)
  const { colMap } = cols
  const sig = (s: DiffSide, r: number, side: 'a' | 'b') =>
    side === 'b'
      ? colMap.map((_, c) => cell(s.rows, r, c)).join('\u0001')
      : colMap.map((m) => cell(s.rows, r, m)).join('\u0001')
  const changed = (ra: number, rb: number) => {
    const out: number[] = []
    for (let c = 0; c < colMap.length; c++) if (cell(a.rows, ra, colMap[c]) !== cell(b.rows, rb, c)) out.push(c)
    return out
  }

  // 按主键对齐：两边都有这个字段、主键都不重复
  const kb = key && cols.byName ? cols.nb.indexOf(key) : -1
  const ka = kb >= 0 ? colMap[kb] : -1
  const ia = ka >= 0 ? keyIndex(a, ka) : null
  const ib = kb >= 0 ? keyIndex(b, kb) : null
  const pairs: [number, number][] = []
  let byKey = false
  if (ia && ib && ia.size && ib.size) {
    byKey = true
    for (let r = b.from; r < b.rows.length; r++) {
      const ra = ia.get(cell(b.rows, r, kb).trim())
      if (ra !== undefined) pairs.push([ra, r])
    }
  } else {
    const sa = Array.from({ length: Math.max(0, a.rows.length - a.from) }, (_, i) => sig(a, a.from + i, 'a'))
    const sb = Array.from({ length: Math.max(0, b.rows.length - b.from) }, (_, i) => sig(b, b.from + i, 'b'))
    for (const [i, j] of lcs(sa, sb)) pairs.push([a.from + i, b.from + j])
  }

  // 拼出按新表顺序的行；旧表里没配上的插在它前一个配上的行后面
  const rows: DiffRow[] = []
  const matchedA = new Set(pairs.map((p) => p[0]))
  const pairOfB = new Map(pairs.map(([ra, rb]) => [rb, ra]))
  let nextA = a.from
  const flushDel = (upto: number) => {
    for (; nextA < upto; nextA++)
      if (!matchedA.has(nextA) && a.rows[nextA]?.some((x) => x)) rows.push({ kind: 'del', a: nextA })
  }
  for (let rb = b.from; rb < b.rows.length; rb++) {
    const ra = pairOfB.get(rb)
    if (ra === undefined) {
      if (b.rows[rb]?.some((x) => x)) rows.push({ kind: 'add', b: rb })
      continue
    }
    if (ra >= nextA) flushDel(ra)
    nextA = Math.max(nextA, ra + 1)
    const cs = changed(ra, rb)
    rows.push(cs.length ? { kind: 'mod', a: ra, b: rb, cols: cs } : { kind: 'same', a: ra, b: rb })
  }
  flushDel(a.rows.length)
  const merged = byKey ? rows : pairGaps(rows, changed)

  const headerChanged: string[] = []
  const hb = Math.min(a.from, b.from)
  for (let c = 0; c < colMap.length; c++) {
    if (colMap[c] < 0) continue
    for (let r = 0; r < hb; r++)
      if (cell(a.rows, r, colMap[c]) !== cell(b.rows, r, c)) {
        headerChanged.push(cols.nb[c] || colLabel(c))
        break
      }
  }
  const stats = { mod: 0, add: 0, del: 0, cells: 0 }
  for (const r of merged) {
    if (r.kind === 'mod') {
      stats.mod++
      stats.cells += r.cols!.length
    } else if (r.kind === 'add') stats.add++
    else if (r.kind === 'del') stats.del++
  }
  return {
    rows: merged,
    colMap,
    key: byKey ? key : '',
    addedCols: cols.addedCols,
    removedCols: cols.removedCols,
    headerChanged,
    stats,
  }
}

/** 没有主键时：一段连续的删 + 加按顺序配成改（改了一格的行不算删一行加一行） */
function pairGaps(rows: DiffRow[], changed: (a: number, b: number) => number[]): DiffRow[] {
  const out: DiffRow[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'del' && rows[i].kind !== 'add') {
      out.push(rows[i++])
      continue
    }
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && (rows[i].kind === 'del' || rows[i].kind === 'add'))
      (rows[i].kind === 'del' ? dels : adds).push(rows[i++])
    const n = Math.min(dels.length, adds.length)
    for (let k = 0; k < n; k++)
      out.push({ kind: 'mod', a: dels[k].a, b: adds[k].b, cols: changed(dels[k].a!, adds[k].b!) })
    out.push(...dels.slice(n), ...adds.slice(n))
  }
  return out
}

/** 「只看变化」：没变的连续几行折成一段，前后各留 context 行 */
export type DiffLine = { row: DiffRow } | { fold: [number, number]; count: number }
export function foldSame(rows: DiffRow[], context = 1): DiffLine[] {
  const out: DiffLine[] = []
  const near = rows.map((r) => r.kind !== 'same')
  const keep = rows.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) if (near[k]) return true
    return false
  })
  let i = 0
  while (i < rows.length) {
    if (keep[i]) {
      out.push({ row: rows[i++] })
      continue
    }
    const s = i
    while (i < rows.length && !keep[i]) i++
    const first = rows[s].b ?? rows[s].a ?? 0
    const last = rows[i - 1].b ?? rows[i - 1].a ?? 0
    out.push({ fold: [first, last], count: i - s })
  }
  return out
}

/**
 * 跨项目对比的「拷到另一边」：差异是 目标(a) → 来源(b)，把选中的行从来源写到目标。
 * 改过的行只写不一样的格子，只在来源有的行加在目标最后一行有内容的后面；按字段名对齐列，
 * 目标没有的列写不了（列在 dropped 里）。返回的 edit 交给保存接口（和表格页的保存同一套原地写入）
 */
export function copyRows(
  target: string[][],
  source: string[][],
  diff: SheetDiff,
  picked: DiffRow[],
  sheet: string,
): {
  edit: { name: string; rows: { at: number; n: number }[]; cells: { r: number; c: number; v: string }[] }
  touched: { r: number; c: number }[]
  dropped: string[]
} {
  const cells: { r: number; c: number; v: string }[] = []
  const dropped = new Set<string>()
  const width = diff.colMap.length
  for (const row of picked)
    if (row.kind === 'mod')
      for (const c of row.cols ?? []) {
        if (diff.colMap[c] < 0) dropped.add(colLabel(c))
        else cells.push({ r: row.a!, c: diff.colMap[c], v: source[row.b!]?.[c] ?? '' })
      }
  const adds = picked.filter((r) => r.kind === 'add')
  let end = target.length
  while (end > 0 && !(target[end - 1] ?? []).some((x) => x)) end--
  adds.forEach((row, i) => {
    for (let c = 0; c < width; c++) {
      const v = source[row.b!]?.[c] ?? ''
      if (!v) continue
      if (diff.colMap[c] < 0) dropped.add(colLabel(c))
      else cells.push({ r: end + i, c: diff.colMap[c], v })
    }
  })
  return {
    edit: { name: sheet, rows: adds.length ? [{ at: end, n: adds.length }] : [], cells },
    touched: cells.map(({ r, c }) => ({ r, c })),
    dropped: [...dropped],
  }
}
