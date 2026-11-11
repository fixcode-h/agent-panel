/**
 * 表格的三方合并（版本冲突时）：共同的祖先（base）、我这边（ours，冲突时工作区里的就是它）、对方（theirs），
 * 按主键对齐行、按字段名对齐列，逐格合：只有一边改了就用改了的那边，两边改成一样也直接用，
 * 两边改得不一样才算冲突，让用户挑。结果是「在 ours 上要做的行操作 + 改完的样子」，
 * 交给表格页当一次改动，用户看过再保存——写文件走的还是保存那条会验证的路，不在这里直接写盘
 */
import type { SheetData } from './files.ts'
import type { TableSchema } from './tables.ts'
import type { RowOp } from './table-edit.ts'
import { headerOf } from './table-struct.ts'
import { t } from './i18n.ts'

export type Side = 'ours' | 'theirs'

export interface MergeConflict {
  id: string
  sheet: string
  /** cell：两边都改了同一格；row：一边删了这一行、另一边改了；header：两边都改了表头 */
  kind: 'cell' | 'row' | 'header'
  /** 这一行的主键（表头冲突时为空） */
  key: string
  field: string
  /** null = 那一边没有这一行（删了 / 还没加） */
  base: string | null
  ours: string | null
  theirs: string | null
}

export interface MergedSheet {
  name: string
  /** 合并后的样子 */
  rows: string[][]
  /** 从 ours 变成上面这样要做的行操作（行号按做完前面的操作算） */
  ops: RowOp[]
}

export interface MergeResult {
  sheets: MergedSheet[]
  conflicts: MergeConflict[]
  /** 自动合进来的对方的改动（格子、加的行、删的行） */
  auto: number
  /** 合不了、只能提示的：对方加了工作表之类 */
  notes: string[]
}

type Row = Map<string, string>
interface Side3 {
  head: string[][]
  /** 主键 → 这一行（按列 id 取值） */
  rows: Map<string, Row>
  order: string[]
  /** 主键 → 在原表里的行号（只 ours 用） */
  at: Map<string, number>
}

const eqRows = (a: string[][], b: string[][]) =>
  a.length === b.length && a.every((r, i) => trimRow(r).join('\u0000') === trimRow(b[i] ?? []).join('\u0000'))
function trimRow(r: string[]) {
  let n = r.length
  while (n > 0 && !r[n - 1]) n--
  return r.slice(0, n)
}

/** 列 id：有字段名用字段名，没有用「#列号」 */
function colIds(head: string[][], nameRow: number, width: number) {
  const names = nameRow >= 0 ? (head[nameRow] ?? []) : []
  const seen = new Set<string>()
  return Array.from({ length: width }, (_, c) => {
    const n = (names[c] ?? '').trim()
    const id = n && !seen.has(n) ? n : `#${c}`
    seen.add(id)
    return id
  })
}

function sideOf(schema: TableSchema, file: string, s: SheetData | undefined, kf: string): Side3 | null {
  if (!s) return null
  const h = headerOf(schema, file, s)
  const end = h.start + h.roles.length
  const head = s.rows.slice(0, end)
  const ni = h.roles.indexOf('name')
  const width = s.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const ids = colIds(head, ni < 0 ? -1 : h.start + ni, width)
  const kc = kf ? ids.indexOf(kf) : -1
  const rows = new Map<string, Row>()
  const order: string[] = []
  const at = new Map<string, number>()
  const dup = new Map<string, number>()
  for (let i = end; i < s.rows.length; i++) {
    const r = s.rows[i] ?? []
    let k = kc >= 0 ? (r[kc] ?? '').trim() : `#${i - end}`
    // 主键重复（或空）：按出现的次数区分，不然两行会互相盖掉
    const n = (dup.get(k) ?? 0) + 1
    dup.set(k, n)
    if (n > 1 || !k) k = `${k}\u0000${n}`
    const m: Row = new Map()
    ids.forEach((id, c) => m.set(id, r[c] ?? ''))
    rows.set(k, m)
    order.push(k)
    at.set(k, i)
  }
  return { head, rows, order, at }
}

const showKey = (k: string) => {
  const i = k.indexOf('\u0000')
  return i < 0 ? k : k.slice(0, i)
}
const rowText = (r: Row | undefined) => (r ? [...r.values()].filter(Boolean).join(' | ').slice(0, 200) : null)
const sameRow = (a: Row, b: Row) => {
  for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? '') !== (b.get(k) ?? '')) return false
  return true
}

/** 在 ours 上要做的行操作：target 里每一项是 ours 的行号或 -1（新行） */
export function opsFor(oursLen: number, target: number[]): RowOp[] {
  const ops: RowOp[] = []
  let i = 0
  let j = 0
  const ins = () => {
    const last = ops[ops.length - 1]
    if (last && last.n > 0 && last.at + last.n === j) last.n++
    else ops.push({ at: j, n: 1 })
  }
  for (const k of target) {
    if (k < 0) {
      ins()
      j++
      continue
    }
    if (k > i) ops.push({ at: j, n: -(k - i) })
    i = k + 1
    j++
  }
  if (oursLen > i) ops.push({ at: j, n: -(oursLen - i) })
  return ops
}

export function mergeSheets(
  schema: TableSchema,
  file: string,
  base: SheetData[],
  ours: SheetData[],
  theirs: SheetData[],
  choices: Record<string, Side> = {},
): MergeResult {
  const conflicts: MergeConflict[] = []
  const notes: string[] = []
  let auto = 0
  const out: MergedSheet[] = []
  for (const x of theirs)
    if (!ours.some((o) => o.name === x.name) && !base.some((b) => b.name === x.name))
      notes.push(t('对方加了工作表「{name}」，这里合不进去，需要在 Excel 里自己加', { name: x.name }))
  for (const os of ours) {
    const name = os.name
    const ts = theirs.find((s) => s.name === name)
    const bs = base.find((s) => s.name === name)
    if (!ts) {
      if (bs) notes.push(t('对方删了工作表「{name}」，这里保留着', { name }))
      continue
    }
    // 主键：结构文件里设的（这张表里有这个字段时），没设就用第一列有字段名的
    const oh = headerOf(schema, file, os)
    const oni = oh.roles.indexOf('name')
    const fields = oni < 0 ? [] : (os.rows[oh.start + oni] ?? []).map((x) => x.trim()).filter(Boolean)
    const kf = schema.style.key && fields.includes(schema.style.key) ? schema.style.key : (fields[0] ?? '')
    const oo = sideOf(schema, file, os, kf)!
    const tt = sideOf(schema, file, ts, kf)!
    const bb = sideOf(schema, file, bs, kf) ?? { head: [], rows: new Map(), order: [], at: new Map() }

    // 表头：一边改了用改了的那边，两边都改了让用户挑
    let headSide: Side = 'ours'
    if (!eqRows(oo.head, tt.head)) {
      if (eqRows(oo.head, bb.head)) {
        headSide = 'theirs'
        auto++
      } else if (!eqRows(tt.head, bb.head)) {
        const id = `${name}\u0001\u0001header`
        conflicts.push({ id, sheet: name, kind: 'header', key: '', field: '', base: null, ours: null, theirs: null })
        headSide = choices[id] ?? 'ours'
      }
    }
    const head = headSide === 'ours' ? oo.head : tt.head
    const hdr = headerOf(schema, file, headSide === 'ours' ? os : ts)
    const ni = hdr.roles.indexOf('name')
    const width = Math.max(
      ...[os, ts].map((s) => s.rows.reduce((m, r) => Math.max(m, r.length), 0)),
      ...head.map((r) => r.length),
    )
    const cols = colIds(head, ni < 0 ? -1 : hdr.start + ni, width)

    // 数据行：先按 ours 的顺序，逐行合
    type Entry = { key: string; from: number; row: Row }
    const list: Entry[] = []
    for (const k of oo.order) {
      const or = oo.rows.get(k)!
      const br = bb.rows.get(k)
      const tr = tt.rows.get(k)
      if (!tr) {
        if (!br) list.push({ key: k, from: oo.at.get(k)!, row: or })
        else if (sameRow(or, br))
          auto++ // 对方删了、我没动：删掉
        else {
          const id = `${name}\u0001${k}\u0001`
          conflicts.push({
            id,
            sheet: name,
            kind: 'row',
            key: showKey(k),
            field: '',
            base: rowText(br),
            ours: rowText(or),
            theirs: null,
          })
          if ((choices[id] ?? 'ours') === 'ours') list.push({ key: k, from: oo.at.get(k)!, row: or })
        }
        continue
      }
      const row: Row = new Map()
      for (const c of cols) {
        const ov = or.get(c) ?? ''
        const tv = tr.get(c) ?? ''
        const bv = br ? (br.get(c) ?? '') : null
        if (ov === tv || tv === bv) row.set(c, ov)
        else if (ov === bv) {
          row.set(c, tv)
          auto++
        } else {
          const id = `${name}\u0001${k}\u0001${c}`
          conflicts.push({ id, sheet: name, kind: 'cell', key: showKey(k), field: c, base: bv, ours: ov, theirs: tv })
          row.set(c, (choices[id] ?? 'ours') === 'ours' ? ov : tv)
        }
      }
      list.push({ key: k, from: oo.at.get(k)!, row })
    }
    // 只在对方那边的行：对方新加的插到它前一行后面；我删了、对方改了的算冲突
    const pos = new Map(list.map((e, i) => [e.key, i]))
    let prev = ''
    for (const k of tt.order) {
      if (oo.rows.has(k)) {
        prev = k
        continue
      }
      const tr = tt.rows.get(k)!
      const br = bb.rows.get(k)
      let take = !br
      if (br && !sameRow(tr, br)) {
        const id = `${name}\u0001${k}\u0001`
        conflicts.push({
          id,
          sheet: name,
          kind: 'row',
          key: showKey(k),
          field: '',
          base: rowText(br),
          ours: null,
          theirs: rowText(tr),
        })
        take = (choices[id] ?? 'ours') === 'theirs'
      } else if (br) auto++ // 我删了、对方没动：保持删掉
      if (take) {
        if (!br) auto++
        const at = prev && pos.has(prev) ? pos.get(prev)! + 1 : 0
        list.splice(at, 0, { key: k, from: -1, row: tr })
        for (let i = at; i < list.length; i++) pos.set(list[i].key, i)
      }
      prev = k
    }

    const hlen = oo.head.length
    const headTarget = headSide === 'ours' || head.length === hlen ? head.map((_, i) => i) : head.map(() => -1)
    const target = [...headTarget, ...list.map((e) => e.from)]
    const rows = [...head.map((r) => [...r]), ...list.map((e) => trimRow(cols.map((c) => e.row.get(c) ?? '')))]
    out.push({ name, rows, ops: opsFor(os.rows.length, target) })
  }
  return { sheets: out, conflicts, auto, notes }
}
