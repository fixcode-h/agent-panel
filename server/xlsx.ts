/**
 * 读 xlsx / xlsm 给文件弹窗当表格看：取每张表的单元格文字，公式取 Excel 存下来的结果，不管图表。
 * 合并单元格、批注、超链接、整行底色、隐藏的工作表这些看表要用的信息另外读（sheets/xlsx-look.ts），只读不改。
 * xlsx 就是一个 zip，里面是几份 XML；只为了看内容不值得引一个上兆的表格库，这里自己拆 zip、按正则取单元格。
 * 老的 .xls 是另一种二进制格式，这里不认，交给系统默认程序。
 */
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { SheetData } from '../shared/files.ts'
import { fillStyles, rowFillCollector, sheetLook } from './sheets/xlsx-look.ts'

/** 超过这么大的表格文件不解析：整份要读进内存再解压 */
export const MAX_XLSX_BYTES = 30_000_000
/** zip 里单个文件解压后最多这么大：防压缩炸弹 */
const MAX_ENTRY = 120_000_000
/**
 * 每张表、整个文件最多读这么多个单元格。默认值给文件弹窗用：再多页面拿到的 JSON 就上十兆了；
 * 表格插件要能改大表（3000 行 × 80 列就 24 万格），按自己的上限读（readXlsx 的 limits）
 */
export const XLSX_LIMITS = { sheetCells: 200_000, bookCells: 600_000 }
export type XlsxLimits = typeof XLSX_LIMITS
const MAX_COLS = 512
/** 每个单元格在 XML 里最多算这么多字节：上限调大时，单个文件解压后的上限跟着放宽，但仍防压缩炸弹 */
const BYTES_PER_CELL = 64

/** 能当表格解析的扩展名 */
export const isXlsxPath = (file: string) => /\.(xlsx|xlsm)$/i.test(file)

interface ZipEntry {
  method: number
  size: number
  offset: number
}

/** 读 zip 的目录：文件名 → 在哪、怎么压的。不认 zip64（表格文件用不到） */
function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  const out = new Map<string, ZipEntry>()
  // 目录结尾记录在文件末尾，后面最多跟 64K 的注释
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a zip')
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break
    const nameLen = buf.readUInt16LE(at + 28)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    out.set(name.replace(/\\/g, '/'), {
      method: buf.readUInt16LE(at + 10),
      size: buf.readUInt32LE(at + 20),
      offset: buf.readUInt32LE(at + 42),
    })
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }
  return out
}

function zipRead(buf: Buffer, entry: ZipEntry | undefined, max = MAX_ENTRY): string {
  if (!entry || buf.readUInt32LE(entry.offset) !== 0x04034b50) return ''
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28)
  const data = buf.subarray(start, start + entry.size)
  if (entry.method === 0) return data.toString('utf8')
  if (entry.method !== 8) throw new Error('unsupported zip method')
  return inflateRawSync(data, { maxOutputLength: max }).toString('utf8')
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
/** XML 里的字：实体还原；Excel 把控制字符写成 _x000D_ 这种，也还原 */
export function xmlText(s: string) {
  if (!s) return ''
  let out = s
  if (out.includes('&'))
    out = out.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e],
    )
  if (out.includes('_x'))
    out = out.replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  return out.replace(/\r\n?/g, '\n')
}

/** 有的生成器给每个标签加命名空间前缀（<x:row>）：去掉，后面按没前缀的名字找 */
const noPrefix = (xml: string) =>
  /<\w+:(worksheet|sst|styleSheet|workbook)\b/.test(xml) ? xml.replace(/<(\/?)\w+:/g, '<$1') : xml

export const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1]

/** 一段富文本（<si> 或 <is>）里的字：几段 <t> 连起来，拼音注音（rPh）不算 */
function richText(inner: string) {
  const body = inner.includes('<rPh') ? inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : inner
  let out = ''
  for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1]
  return xmlText(out)
}

function sharedStrings(xml: string) {
  const out: string[] = []
  for (const m of noPrefix(xml).matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) out.push(m[1] ? richText(m[1]) : '')
  return out
}

/** Excel 自带的日期 / 时间格式编号 */
// 模块状态：常量，加载后不改
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]) // prettier-ignore

/** 每个单元格样式是不是日期：数字单元格是日期时存的是「距 1900 年多少天」，要换成日期才看得懂 */
export function dateStyles(xml: string): boolean[] {
  const x = noPrefix(xml)
  const custom = new Map<number, boolean>()
  for (const m of x.matchAll(/<numFmt\b([^>]*)>/g)) {
    // 引号里的字、方括号里的颜色和条件不算格式字符；剩下的带年月日时分秒就是日期
    const code = xmlText(attr(m[1], 'formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
    custom.set(Number(attr(m[1], 'numFmtId')), /[ymdhs]/i.test(code) && !/general/i.test(code))
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(x)?.[1] ?? ''
  const out: boolean[] = []
  for (const m of xfs.matchAll(/<xf\b([^>]*)>/g)) {
    const id = Number(attr(m[1], 'numFmtId') ?? 0)
    out.push(custom.get(id) ?? DATE_IDS.has(id))
  }
  return out
}

const two = (n: number) => String(n).padStart(2, '0')
/** 日期序号 → 2026-01-31 12:30:00；只有日期或只有时间时只写那一半 */
function dateText(serial: number, date1904: boolean) {
  const secs = Math.round(serial * 86400)
  const days = Math.floor(secs / 86400)
  const rest = secs - days * 86400
  const time = `${two(Math.floor(rest / 3600))}:${two(Math.floor((rest % 3600) / 60))}:${two(rest % 60)}`
  if (days === 0 && !date1904) return time
  const d = new Date(Date.UTC(1899, 11, 30) + (days + (date1904 ? 1462 : 0)) * 86400000)
  const day = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
  return rest ? `${day} ${time}` : day
}

/** 数字按 15 位有效数字显示（Excel 也是）：0.1+0.2 存的是 0.30000000000000004 */
function numberText(v: string) {
  const n = Number(v)
  return Number.isFinite(n) && v.length > 15 ? String(parseFloat(n.toPrecision(15))) : v
}

/** 列名 → 第几列（A → 0，AA → 26） */
export function colOf(ref: string) {
  let n = 0
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

function sheetRows(
  xml: string,
  shared: string[],
  dates: boolean[],
  date1904: boolean,
  budget: number,
  fills?: ReturnType<typeof rowFillCollector>,
): { rows: string[][]; truncated: boolean; cells: number } {
  const rows: string[][] = []
  let row = -1
  let col = -1
  let cells = 0
  let truncated = false
  // 样式表里没有底色时不收，省掉每格查样式
  const fill = fills?.active ? fills : undefined
  for (const m of xml.matchAll(/<row\b([^>]*)>|<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (m[1] !== undefined) {
      const r = Number(attr(m[1], 'r'))
      row = r > 0 ? r - 1 : row + 1
      col = -1
      fill?.row(row, m[1])
      continue
    }
    const tag = m[2]
    fill?.cell(tag)
    const ref = attr(tag, 'r')
    col = ref ? colOf(ref) : col + 1
    const inner = m[3]
    if (!inner || col < 0) continue
    const type = attr(tag, 't')
    const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1]
    let text = ''
    if (type === 'inlineStr') text = richText(inner)
    else if (raw === undefined) {
      // 没存结果的公式（别的工具生成、还没用 Excel 打开算过）：显示公式本身
      const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1]
      if (!f) continue
      text = `=${xmlText(f)}`
    } else if (type === 's') text = shared[Number(raw)] ?? ''
    else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE'
    else if (type === 'str' || type === 'e' || type === 'd') text = xmlText(raw)
    else text = dates[Number(attr(tag, 's') ?? -1)] ? dateText(Number(raw), date1904) : numberText(raw)
    if (!text) continue
    if (col >= MAX_COLS || cells >= budget) {
      truncated = true
      if (cells >= budget) break
      continue
    }
    if (row < 0) row = 0
    while (rows.length <= row) rows.push([])
    const line = rows[row]
    while (line.length < col) line.push('')
    line[col] = text
    cells++
  }
  return { rows, truncated, cells }
}

/** 主题文件：workbook 的 rels 里 …/relationships/theme 那一项，没写就是默认位置 */
function themeFile(rels: Map<string, string>) {
  for (const target of rels.values()) if (/\/theme\/[^/]+\.xml$/.test(target)) return target
  return 'xl/theme/theme1.xml'
}

/**
 * 解析 xlsx：每张表一份「行 × 列」的文字。不是 xlsx（加密的、改了扩展名的）时抛错。
 * 超过 limits 的表只读前面一部分并标 truncated（页面据此只读，免得把没读到的部分当空的写回去）
 */
export function readXlsx(buf: Buffer, limits: XlsxLimits = XLSX_LIMITS): SheetData[] {
  const zip = zipEntries(buf)
  const maxEntry = Math.max(MAX_ENTRY, limits.sheetCells * BYTES_PER_CELL)
  const read = (name: string) => zipRead(buf, zip.get(name), maxEntry)
  const book = noPrefix(read('xl/workbook.xml'))
  if (!book) throw new Error('not an xlsx')
  const rels = new Map<string, string>()
  for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)>/g)) {
    const target = attr(m[1], 'Target') ?? ''
    // 目标相对 xl/，也有写成 /xl/… 绝对路径的
    rels.set(attr(m[1], 'Id') ?? '', target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target))
  }
  const shared = sharedStrings(read('xl/sharedStrings.xml'))
  const stylesXml = read('xl/styles.xml')
  const dates = dateStyles(stylesXml)
  // 主题色在 theme1.xml（底色常写成「主题色 4 + 淡 40%」）
  const fillOf = fillStyles(stylesXml, read(themeFile(rels)))
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(book)
  const out: SheetData[] = []
  let left = limits.bookCells
  for (const m of book.matchAll(/<sheet\b([^>]*)>/g)) {
    const name = xmlText(attr(m[1], 'name') ?? '')
    const file = rels.get(attr(m[1], 'r:id') ?? attr(m[1], 'id') ?? '')
    // 图表页（chartsheet）没有单元格，不列
    if (!file || !file.includes('worksheets/')) continue
    const state = attr(m[1], 'state')
    const hidden = state === 'hidden' || state === 'veryHidden' ? { hidden: true } : {}
    if (left <= 0) {
      out.push({ name, rows: [], truncated: true, ...hidden })
      continue
    }
    const xml = noPrefix(read(file))
    const fills = rowFillCollector(fillOf)
    const got = sheetRows(xml, shared, dates, date1904, Math.min(limits.sheetCells, left), fills)
    left -= got.cells
    const look = sheetLook(xml, file, read, fills.done())
    out.push({
      name,
      rows: got.rows,
      ...(got.truncated ? { truncated: true } : {}),
      ...hidden,
      ...(look ? { look } : {}),
    })
  }
  return out
}

/** 文件是表格并且解析得出来时给出各张表；不是、太大、解析不了都返回 undefined（照旧按二进制文件显示） */
export function sheetsOf(file: string, buf: Buffer): SheetData[] | undefined {
  if (!isXlsxPath(file) || buf.length > MAX_XLSX_BYTES) return undefined
  try {
    return readXlsx(buf)
  } catch {
    return undefined
  }
}
