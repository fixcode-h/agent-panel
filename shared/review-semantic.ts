/**
 * 评审的「二进制文件语义差异」（UE 2）：git diff 对 .xlsx、.uasset 只有一行「二进制文件不同」，
 * 用户定的「不管改多少都要代码审查」对这类改动等于没审。这里把两版内容换成评审读得懂的文字：
 * 表格按格子比（和表格页的版本差异同一套 diffSheet），插件认领的扩展名按插件转出的文本逐行比。
 * 这份文字是发给评审 Agent 的提示词，不翻译。取内容（git、p4、插件）在 server/exec/review-semantic.ts
 */
import type { SheetData } from './files.ts'
import { diffSheet, foldSame, type DiffSide } from './sheet-diff.ts'
import { headerOf } from './table-struct.ts'
import { fieldNames } from './table-agent.ts'
import type { TableSchema } from './tables.ts'

/** 一个文件的语义差异最多这么多字：再长截掉，评审按文件列表自己去看 */
export const SEMANTIC_FILE_MAX = 12_000
/** 全部文件合起来的上限 */
export const SEMANTIC_MAX = 40_000
/** 一格的值在差异里最多显示的字数 */
const CELL_MAX = 120

const short = (v: string) => {
  const s = v.replace(/\r?\n/g, '⏎')
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…` : s
}
const quote = (v: string) => (v === '' ? '（空）' : short(v))

function sideOf(schema: TableSchema, file: string, sheet: SheetData): DiffSide {
  const h = headerOf(schema, file, sheet)
  return { rows: sheet.rows, from: h.start + h.roles.length, names: fieldNames(sheet.rows, h) }
}

const colName = (names: string[] | undefined, c: number) => names?.[c] || `第 ${c + 1} 列`

/** 一行有内容的格子写成「字段=值」，空格子不写 */
function rowText(row: string[] | undefined, names: string[] | undefined) {
  const cells = (row ?? []).flatMap((v, c) => (v.trim() ? [`${colName(names, c)}=${short(v)}`] : []))
  const s = cells.join('，')
  return s.length > 600 ? `${s.slice(0, 600)}…` : s || '（空行）'
}

/** 一张工作表两版的格子级差异；没有变化返回空串 */
function sheetText(file: string, name: string, a: SheetData, b: SheetData, schema: TableSchema) {
  const sa = sideOf(schema, file, a)
  const sb = sideOf(schema, file, b)
  const d = diffSheet(sa, sb, schema.style.key)
  const { mod, add, del, cells } = d.stats
  if (!mod && !add && !del && !d.addedCols.length && !d.removedCols.length && !d.headerChanged.length) return ''
  const kc = d.key ? (sb.names ?? []).indexOf(d.key) : -1
  // 行怎么称呼：有主键用主键，没有用表格软件里的行号（从 1 数）
  const label = (row: string[] | undefined, n: number | undefined) =>
    kc >= 0 && row?.[kc] ? `${d.key}=${row[kc]}` : n === undefined ? '' : `第 ${n + 1} 行`
  const head = [
    `工作表「${name}」：改 ${mod} 行（${cells} 格）、加 ${add} 行、删 ${del} 行`,
    d.key ? `按主键 ${d.key} 对齐行` : '没有主键，按整行内容对齐',
    d.addedCols.length ? `新加列 ${d.addedCols.join('、')}` : '',
    d.removedCols.length ? `去掉列 ${d.removedCols.join('、')}` : '',
    d.headerChanged.length ? `表头（类型、注释）变了的列 ${d.headerChanged.join('、')}` : '',
  ].filter(Boolean)
  const lines = [head.join('；')]
  if (a.truncated || b.truncated) lines.push('（表太大，只比了前面读出来的部分）')
  for (const r of d.rows) {
    if (r.kind === 'same') continue
    const ra = r.a === undefined ? undefined : a.rows[r.a]
    const rb = r.b === undefined ? undefined : b.rows[r.b]
    if (r.kind === 'mod') {
      const what = (r.cols ?? []).map(
        (c) => `${colName(sb.names, c)} ${quote(ra?.[d.colMap[c]] ?? '')} → ${quote(rb?.[c] ?? '')}`,
      )
      lines.push(`- 改 ${label(rb, r.b)}：${what.join('；')}`)
    } else if (r.kind === 'add') lines.push(`- 加 ${label(rb, r.b)}：${rowText(rb, sb.names)}`)
    else lines.push(`- 删 ${label(ra, r.a)}：${rowText(ra, sa.names)}`)
  }
  return lines.join('\n')
}

/** 新建或删掉的整个表格：列出工作表、行数和字段，内容太多不逐行列 */
function wholeBook(sheets: SheetData[], schema: TableSchema, file: string) {
  return sheets
    .map((s) => {
      const side = sideOf(schema, file, s)
      const names = (side.names ?? []).filter(Boolean)
      return `- 工作表「${s.name}」：${Math.max(0, s.rows.length - side.from)} 行数据${names.length ? `，字段 ${names.join('、')}` : ''}`
    })
    .join('\n')
}

/** 两版表格（null 是这一版没有这个文件）的格子级差异文字；没有变化返回空串 */
export function workbookDiffText(file: string, a: SheetData[] | null, b: SheetData[] | null, schema: TableSchema) {
  if (!a && !b) return ''
  if (!a) return `新建的表格：\n${wholeBook(b!, schema, file)}`
  if (!b) return `删掉的表格（原来的内容）：\n${wholeBook(a, schema, file)}`
  const out: string[] = []
  const names = new Set(a.map((s) => s.name))
  for (const s of b) {
    const old = a.find((x) => x.name === s.name)
    if (!old) out.push(`新加的工作表：\n${wholeBook([s], schema, file)}`)
    else {
      const t = sheetText(file, s.name, old, s, schema)
      if (t) out.push(t)
    }
    names.delete(s.name)
  }
  for (const n of names) out.push(`删掉的工作表：\n${wholeBook([a.find((x) => x.name === n)!], schema, file)}`)
  return out.join('\n\n')
}

/**
 * 两段文本逐行的差异（插件转出来的文本用）：借表格差异的 LCS，每行当一格，
 * 写成 unified diff 的样子（「-」旧、「+」新、空格是前后没改的行，「@@ … @@」是省掉的没改的行数）
 */
export function lineDiffText(a: string, b: string, context = 3) {
  const split = (s: string) => (s ? s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [])
  const la = split(a)
  const lb = split(b)
  const d = diffSheet({ rows: la.map((l) => [l]), from: 0 }, { rows: lb.map((l) => [l]), from: 0 })
  if (!d.stats.mod && !d.stats.add && !d.stats.del) return ''
  const out: string[] = []
  for (const x of foldSame(d.rows, context)) {
    if ('fold' in x) {
      out.push(`@@ 省掉 ${x.count} 行没改的 @@`)
      continue
    }
    const r = x.row
    if (r.kind === 'same') out.push(` ${lb[r.b!]}`)
    if (r.kind === 'mod' || r.kind === 'del') out.push(`-${la[r.a!]}`)
    if (r.kind === 'mod' || r.kind === 'add') out.push(`+${lb[r.b!]}`)
  }
  return out.join('\n')
}

/** 一个文件的语义差异：how 说明是怎么比的（表格按格子、哪个插件转的文本），text 为空表示两版读出来一样 */
export interface SemanticPart {
  path: string
  how: string
  text: string
  /** 读不出来、插件出错：如实写给评审 */
  error?: string
}

/** 拼成评审提示词里的一节；没有一个认得的二进制文件时返回空串 */
export function semanticSection(parts: SemanticPart[]) {
  if (!parts.length) return ''
  let room = SEMANTIC_MAX
  const blocks: string[] = []
  for (const p of parts) {
    const body = p.error
      ? `读不出语义差异：${p.error}`
      : p.text
        ? p.text.length > SEMANTIC_FILE_MAX
          ? `${p.text.slice(0, SEMANTIC_FILE_MAX)}\n…（太长，后面的没放进来）`
          : p.text
        : '两版读出来的内容一样（只是文件字节不同，比如重新保存过）。'
    const block = `### ${p.path}（${p.how}）\n\`\`\`\n${body}\n\`\`\``
    if (block.length > room) {
      blocks.push(`（还有 ${parts.length - blocks.length} 个文件的语义差异放不下，按上面的文件列表自己看）`)
      break
    }
    room -= block.length
    blocks.push(block)
  }
  return `## 二进制文件的语义差异\n上面 diff 里只显示「二进制文件不同」的文件，面板按内容整理成了下面的文字（表格按格子比、其他按认领它的插件转出的文本比），按它们评审这些文件的改动。\n\n${blocks.join('\n\n')}`
}
