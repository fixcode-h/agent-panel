/**
 * 原地改 xlsx 的单元格：只动改了的 <c>（和需要时新加的 <row>），样式号 s 留着，共享字符串在末尾追加，
 * 其余 XML 一个字节不改；没改的工作表、样式、图片、宏等 zip 条目整段照搬（见 zip.ts）。
 * 公式格不让改（改了缓存值和公式就对不上）；有公式、合并单元格、条件格式、数据验证、超链接、表格对象、
 * 名称定义的表不让在中间插删行（这些东西里的引用要跟着挪，这里不做）——都直接报错，交给表格软件。
 * 改完由调用方重新解析、和预期逐格比对（write.ts）。
 */
import path from 'node:path'
import { t } from '../../shared/i18n.ts'
import { cellRef, type CellSet, type RowOp, type SheetEdit } from '../../shared/table-edit.ts'
import { attr, colOf, dateStyles, xmlText } from '../xlsx.ts'
import { entryText, readZip, writeZip } from './zip.ts'

const PREFIXED = /<\w+:(worksheet|sst|workbook)\b/

class UnsupportedError extends Error {}
const unsupported = (why: string): never => {
  throw new UnsupportedError(why)
}

/** XML 里不能直接写的控制字符（制表、换行、回车除外）：写成 Excel 的 _x000B_ */
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g
/** 写进 XML 的字：转义，控制字符写成 Excel 的 _x000B_，原文里像转义的 _x0041_ 也转一下免得读回来变样 */
function esc(s: string) {
  return s
    .replace(/_x([0-9a-fA-F]{4})_/g, '_x005F_x$1_')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(CONTROL, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0')}_`)
}
const tText = (s: string) => `<t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${esc(s)}</t>`

/** 共享字符串表：认得的纯文字条目复用，新的追加到末尾 */
class Sst {
  private index = new Map<string, number>()
  private added: string[] = []
  private size = 0
  private refs = 0
  constructor(private xml: string) {
    let i = 0
    for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
      const plain = m[1] && /^<t\b[^>]*>([\s\S]*?)<\/t>$/.exec(m[1].trim())
      if (plain) {
        const text = xmlText(plain[1])
        if (!this.index.has(text)) this.index.set(text, i)
      } else if (!m[1] && !this.index.has('')) this.index.set('', i)
      i++
    }
    this.size = i
  }
  get changed() {
    return this.refs > 0
  }
  add(text: string) {
    this.refs++
    const hit = this.index.get(text)
    if (hit !== undefined) return hit
    const i = this.size++
    this.added.push(`<si>${tText(text)}</si>`)
    this.index.set(text, i)
    return i
  }
  out() {
    const bump = (s: string, name: string, by: number) =>
      s.replace(new RegExp(`(<sst\\b[^>]*\\s${name}=")(\\d+)(")`), (_, a, n, b) => `${a}${Number(n) + by}${b}`)
    let x = bump(this.xml, 'count', this.refs)
    x = bump(x, 'uniqueCount', this.added.length)
    if (!this.added.length) return x
    if (/<sst\b[^>]*\/>/.test(x)) return x.replace(/<sst\b([^>]*)\/>/, `<sst$1>${this.added.join('')}</sst>`)
    return x.replace(/<\/sst>\s*$/, `${this.added.join('')}</sst>`)
  }
}

interface Ctx {
  sst: Sst | null
  dates: boolean[]
  date1904: boolean
}

interface Cell {
  col: number
  raw: string
}
interface Row {
  /** 第几行，从 0 数 */
  r: number
  attrs: string
  /** 没动过时原样输出 */
  raw?: string
  cells?: Cell[]
}

const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/
/** 能原样存成数字：读回来（15 位有效数字）还是这几个字 */
const asNumber = (v: string) => NUM.test(v) && v.replace(/^-|\.|e.*$/gi, '').length <= 15 && Number.isFinite(Number(v))

/** 日期格子：页面上显示成 2026-01-31（12:30:00），写回时换回 Excel 的日期序号 */
function dateSerial(v: string, date1904: boolean): number | null {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2}))?(?:\s*(\d{2}):(\d{2}):(\d{2}))?$/.exec(v.trim())
  if (!m || (!m[1] && !m[4])) return null
  const time = m[4] ? (Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6])) / 86400 : 0
  if (!m[1]) return time
  const days = (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 86400000
  return days - (date1904 ? 1462 : 0) + time
}

function parseRow(m: RegExpMatchArray): Row {
  const attrs = m[1]
  const r = Number(attr(attrs, 'r'))
  if (!(r > 0)) unsupported(t('表格里有没写行号的行'))
  return { r: r - 1, attrs, raw: m[0] }
}

function cellsOf(row: Row): Cell[] {
  if (row.cells) return row.cells
  const inner = /^<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)$/.exec(row.raw!)?.[1] ?? ''
  const cells: Cell[] = []
  let col = -1
  let rest = inner
  for (const m of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr(m[1], 'r')
    col = ref ? colOf(ref) : col + 1
    cells.push({ col, raw: m[0] })
    rest = rest.replace(m[0], '')
  }
  // 行里除了单元格还有别的东西（扩展信息）：不认识，不冒险改
  if (rest.trim()) unsupported(t('表格里有不认识的行内容'))
  row.cells = cells
  return cells
}

/** 行号变了：行的 r 和每格的 r 都改掉 */
function moveRow(row: Row, to: number) {
  const cells = cellsOf(row)
  for (const c of cells) c.raw = c.raw.replace(/(<c\b[^>]*?\sr=")([A-Z]+)\d+(")/, `$1$2${to + 1}$3`)
  row.r = to
  row.raw = undefined
}

/** 新格子的类型、样式跟同一列最近的上一格走（追加行时和上面的行一个样） */
function aboveCell(rows: Row[], r: number, col: number): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].r >= r) continue
    const hit = cellsOf(rows[i]).find((c) => c.col === col)
    if (hit) return hit.raw
  }
  return undefined
}

function newCell(ref: string, v: string, old: string | undefined, like: string | undefined, ctx: Ctx): string | null {
  const head = (old ?? like ?? '').match(/^<c\b([^>]*?)\/?>/)?.[1] ?? ''
  const s = attr(head, 's')
  const keep = old ? head.replace(/\s(r|t)="[^"]*"/g, '').replace(/\/$/, '') : s ? ` s="${s}"` : ''
  const open = (type?: string) => `<c r="${ref}"${keep}${type ? ` t="${type}"` : ''}`
  if (v === '') return s || (old && /\s\w+="/.test(keep)) ? `${open()}/>` : null
  const src = old ?? like
  const type = src ? attr(src.match(/^<c\b([^>]*?)\/?>/)?.[1] ?? '', 't') : undefined
  const isText = type === 's' || type === 'inlineStr' || type === 'str'
  if (!isText) {
    if (type === 'b' && /^(true|false)$/i.test(v)) return `${open('b')}><v>${/^true$/i.test(v) ? 1 : 0}</v></c>`
    if (s && ctx.dates[Number(s)]) {
      const n = dateSerial(v, ctx.date1904)
      if (n !== null) return `${open()}><v>${n}</v></c>`
    }
    if (asNumber(v)) return `${open()}><v>${v}</v></c>`
  }
  if (ctx.sst) return `${open('s')}><v>${ctx.sst.add(v)}</v></c>`
  return `${open('inlineStr')}><is>${tText(v)}</is></c>`
}

/** 这张表能不能在中间插删行 */
function rowOpsBlocked(xml: string, book: string) {
  const why: string[] = []
  if (/<(\w+:)?f[\s>/]/.test(xml)) why.push(t('公式'))
  if (/<mergeCell\b/.test(xml)) why.push(t('合并单元格'))
  if (/<conditionalFormatting\b/.test(xml)) why.push(t('条件格式'))
  if (/<dataValidation\b/.test(xml)) why.push(t('数据验证'))
  if (/<hyperlink\b/.test(xml)) why.push(t('超链接'))
  if (/<tablePart\b/.test(xml)) why.push(t('表格对象'))
  if (/<definedName\b/.test(book)) why.push(t('名称定义'))
  return why
}

function editSheet(xml: string, edit: SheetEdit, book: string, ctx: Ctx): string {
  if (PREFIXED.test(xml)) unsupported(t('这个表格的写法比较少见（带命名空间前缀）'))
  const open = /<sheetData\b[^>]*?(\/?)>/.exec(xml)
  if (!open) unsupported(t('表格里没有单元格区'))
  const start = open!.index + open![0].length
  const close = open![1] ? start : xml.indexOf('</sheetData>', start)
  if (close < 0) unsupported(t('表格里没有单元格区'))
  const body = xml.slice(start, close)
  const rows: Row[] = [...body.matchAll(/<row\b([^>]*?)(?:\/>|>[\s\S]*?<\/row>)/g)].map(parseRow)
  const last = rows.length ? rows[rows.length - 1].r : -1

  // 行操作：追加在末尾的总可以；其余的要表里没有会跟着挪的引用
  const ops: RowOp[] = edit.rows
  if (ops.some((op) => op.at <= last)) {
    const why = rowOpsBlocked(xml, book)
    if (why.length) unsupported(t('这张表有{what}，不能在中间插入或删除行，请在表格软件里做', { what: why.join('、') }))
  }
  let list = rows
  for (const op of ops) {
    if (op.n > 0) {
      for (const row of list) if (row.r >= op.at) moveRow(row, row.r + op.n)
    } else {
      const end = op.at - op.n
      list = list.filter((row) => row.r < op.at || row.r >= end)
      for (const row of list) if (row.r >= end) moveRow(row, row.r + op.n)
    }
  }

  // 改格子：按行分组
  const byRow = new Map<number, CellSet[]>()
  for (const c of edit.cells) byRow.set(c.r, [...(byRow.get(c.r) ?? []), c])
  for (const [r, sets] of byRow) {
    let row = list.find((x) => x.r === r)
    if (!row) {
      row = { r, attrs: ` r="${r + 1}"`, cells: [] }
      list.push(row)
      list.sort((a, b) => a.r - b.r)
    }
    const cells = cellsOf(row)
    for (const { c, v } of sets) {
      const ref = cellRef(r, c)
      const i = cells.findIndex((x) => x.col === c)
      const old = i >= 0 ? cells[i].raw : undefined
      if (old && /<(\w+:)?f[\s>/]/.test(old)) unsupported(t('{ref} 是公式格，不能在这里改', { ref }))
      const made = newCell(ref, v, old, old ? undefined : aboveCell(list, r, c), ctx)
      if (i >= 0) {
        if (made) cells[i].raw = made
        else cells.splice(i, 1)
      } else if (made) {
        const at = cells.findIndex((x) => x.col > c)
        cells.splice(at < 0 ? cells.length : at, 0, { col: c, raw: made })
        // spans 只是给读取程序的提示，新格子超出范围时去掉，免得提示错
        row.attrs = row.attrs.replace(/\sspans="[^"]*"/, '')
      }
    }
    row.raw = undefined
  }

  const out = list
    .map((row) => {
      if (row.raw !== undefined) return row.raw
      const attrs = row.attrs.replace(/(\sr=")\d+(")/, `$1${row.r + 1}$2`)
      const cells = row.cells ?? []
      return cells.length ? `<row${attrs}>${cells.map((c) => c.raw).join('')}</row>` : `<row${attrs}/>`
    })
    .join('')
  const head = open![1] ? xml.slice(0, open!.index) + open![0].replace(/\/>$/, '>') : xml.slice(0, start)
  const tail = open![1] ? `</sheetData>${xml.slice(start)}` : xml.slice(close)
  return fixDimension(head, list) + out + tail
}

/** <dimension ref="A1:G120"/>：改完按实际的行列重算右下角 */
function fixDimension(head: string, rows: Row[]) {
  const m = /<dimension\b[^>]*\sref="([A-Z]+\d+)(?::[A-Z]+\d+)?"/.exec(head)
  if (!m) return head
  let maxR = 0
  let maxC = 0
  for (const row of rows) {
    const cells =
      row.cells ?? [...(row.raw ?? '').matchAll(/<c\b[^>]*?\sr="([A-Z]+)\d+"/g)].map((x) => ({ col: colOf(x[1]) }))
    if (!cells.length) continue
    maxR = Math.max(maxR, row.r + 1)
    for (const c of cells) maxC = Math.max(maxC, c.col + 1)
  }
  if (!maxR) return head
  const to = cellRef(maxR - 1, maxC - 1)
  return head.replace(m[0], m[0].replace(/ref="[^"]*"/, `ref="${m[1] === to ? to : `${m[1]}:${to}`}"`))
}

/** 改一个 xlsx：返回新文件的字节。表格写法不支持、改公式格、不能插删行时抛错（错误信息给用户看） */
export function editXlsx(buf: Buffer, edits: SheetEdit[]): Buffer {
  const zip = readZip(buf)
  const book = entryText(zip, 'xl/workbook.xml')
  if (!book) unsupported(t('不是 xlsx 文件'))
  if (PREFIXED.test(book!)) unsupported(t('这个表格的写法比较少见（带命名空间前缀）'))
  const rels = new Map<string, string>()
  for (const m of (entryText(zip, 'xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)>/g)) {
    const target = attr(m[1], 'Target') ?? ''
    rels.set(attr(m[1], 'Id') ?? '', target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target))
  }
  const sheets = new Map<string, string>()
  for (const m of book!.matchAll(/<sheet\b([^>]*)>/g)) {
    const part = rels.get(attr(m[1], 'r:id') ?? attr(m[1], 'id') ?? '')
    if (part) sheets.set(xmlText(attr(m[1], 'name') ?? ''), part)
  }
  const sstText = entryText(zip, 'xl/sharedStrings.xml')
  if (sstText && PREFIXED.test(sstText)) unsupported(t('这个表格的写法比较少见（带命名空间前缀）'))
  const ctx: Ctx = {
    sst: sstText ? new Sst(sstText) : null,
    dates: dateStyles(entryText(zip, 'xl/styles.xml') ?? ''),
    date1904: /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(book!),
  }
  const replace = new Map<string, string>()
  let formulas = false
  for (const e of edits) {
    if (!e.cells.length && !e.rows.length) continue
    const part = sheets.get(e.name)
    if (!part) unsupported(t('找不到工作表：{name}', { name: e.name }))
    const xml = entryText(zip, part!)
    if (xml === null) unsupported(t('找不到工作表：{name}', { name: e.name }))
    replace.set(part!, editSheet(xml!, e, book!, ctx))
    if (/<(\w+:)?f[\s>/]/.test(xml!)) formulas = true
  }
  if (ctx.sst?.changed) replace.set('xl/sharedStrings.xml', ctx.sst.out())
  // 有公式的表改了值：让 Excel / WPS 打开时重算一遍，公式的缓存值不会停在旧数上
  if (formulas && /<calcPr\b/.test(book!) && !/fullCalcOnLoad="(1|true)"/.test(book!))
    replace.set('xl/workbook.xml', book!.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"'))
  return writeZip(zip, replace)
}

export const isUnsupported = (e: unknown) => e instanceof UnsupportedError
