import path from 'node:path'
import type { SheetLink, SheetLook, SheetMerge, SheetNote, SheetRowFill } from '../../shared/files.ts'
import { attr, xmlText } from '../xlsx.ts'

/**
 * xlsx 里格子文字之外、看表时要还原的几样（只读，表格页和文件弹窗都用）：
 * 合并单元格（<mergeCells>）、批注（comments*.xml）、超链接（<hyperlinks> + 工作表的 rels）、整行的底色（styles.xml 的 fill）。
 * 都按正则取，和 server/xlsx.ts 读格子一样不引表格库。保存只改格子的值（插件的原地改写），这些原样留在文件里。
 */

/** 单张表最多带这么多条，再多页面拿到的 JSON 太大，表也没法看 */
const MAX_MERGES = 20_000
const MAX_NOTES = 5_000
const MAX_LINKS = 5_000
/** 一条批注最多这么多字：批注里贴整段文档的也有，悬停只看前面 */
const MAX_NOTE_LEN = 2_000

/** 有的生成器给每个标签加命名空间前缀（<x:comments>）：去掉，按没前缀的名字找 */
const noPrefix = (xml: string) => (/<\w+:(comments|styleSheet)\b/.test(xml) ? xml.replace(/<(\/?)\w+:/g, '<$1') : xml)

/** A1 → 行列（从 0 数）；不是格子地址返回 undefined */
export function cellAt(ref: string): { r: number; c: number } | undefined {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref.trim().toUpperCase())
  if (!m) return undefined
  let c = 0
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64)
  return { r: Number(m[2]) - 1, c: c - 1 }
}

/** A1:C3 → 范围；单格写法（A1）也认 */
function rangeAt(ref: string) {
  const [a, b] = ref.split(':')
  const p = cellAt(a)
  const q = b ? cellAt(b) : p
  if (!p || !q) return undefined
  return { r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) }
}

export function readMerges(sheetXml: string): SheetMerge[] {
  const block = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(sheetXml)?.[1]
  if (!block) return []
  const out: SheetMerge[] = []
  for (const m of block.matchAll(/<mergeCell\b([^>]*)\/?>/g)) {
    const g = rangeAt(attr(m[1], 'ref') ?? '')
    // 只有一格的「合并」没意义
    if (!g || (g.r0 === g.r1 && g.c0 === g.c1)) continue
    out.push({ r: g.r0, c: g.c0, rows: g.r1 - g.r0 + 1, cols: g.c1 - g.c0 + 1 })
    if (out.length >= MAX_MERGES) break
  }
  return out
}

/** 工作表的 rels：rId → 目标（相对 xl/worksheets/ 解析成 zip 里的路径，外部链接原样） */
export function sheetRels(relsXml: string, sheetFile: string) {
  const out = new Map<string, { target: string; type: string; external: boolean }>()
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const target = xmlText(attr(m[1], 'Target') ?? '')
    const external = attr(m[1], 'TargetMode') === 'External'
    const resolved = external
      ? target
      : target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(sheetFile), target))
    out.set(attr(m[1], 'Id') ?? '', { target: resolved, type: attr(m[1], 'Type') ?? '', external })
  }
  return out
}

/** 外部链接只认这几种协议：别的（javascript:、file:）不当链接画，免得点了出事 */
const SAFE_URL = /^(https?:|mailto:)/i

export function readLinks(sheetXml: string, rels: ReturnType<typeof sheetRels>): SheetLink[] {
  const block = /<hyperlinks\b[^>]*>([\s\S]*?)<\/hyperlinks>/.exec(sheetXml)?.[1]
  if (!block) return []
  const out: SheetLink[] = []
  for (const m of block.matchAll(/<hyperlink\b([^>]*)\/?>/g)) {
    const g = rangeAt(attr(m[1], 'ref') ?? '')
    if (!g) continue
    const rid = attr(m[1], 'r:id') ?? attr(m[1], 'id')
    const rel = rid ? rels.get(rid) : undefined
    const url = rel?.external && SAFE_URL.test(rel.target) ? rel.target : undefined
    const loc = xmlText(attr(m[1], 'location') ?? '') || undefined
    if (!url && !loc) continue
    const tip = xmlText(attr(m[1], 'tooltip') ?? '') || undefined
    // 一个链接可以盖一片格子：每格一条，页面按格子查
    for (let r = g.r0; r <= g.r1 && out.length < MAX_LINKS; r++)
      for (let c = g.c0; c <= g.c1 && out.length < MAX_LINKS; c++)
        out.push({ r, c, ...(url ? { url } : {}), ...(loc ? { loc } : {}), ...(tip ? { tip } : {}) })
    if (out.length >= MAX_LINKS) break
  }
  return out
}

/** 批注文件（comments1.xml）：几段 <t> 连起来；作者名单在 <authors> 里按序号查 */
export function readNotes(commentsXml: string): SheetNote[] {
  const x = noPrefix(commentsXml)
  if (!x) return []
  const authors = [
    ...(/<authors\b[^>]*>([\s\S]*?)<\/authors>/.exec(x)?.[1] ?? '').matchAll(/<author>([\s\S]*?)<\/author>/g),
  ].map((m) => xmlText(m[1]))
  const out: SheetNote[] = []
  for (const m of x.matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/g)) {
    const at = cellAt(attr(m[1], 'ref') ?? '')
    if (!at) continue
    let text = ''
    const body = m[2].includes('<rPh') ? m[2].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : m[2]
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += t[1]
    text = xmlText(text).trim()
    const author = authors[Number(attr(m[1], 'authorId') ?? -1)]
    // Excel 把作者名写在正文开头（「张三:\n…」），已经单独列了作者就去掉这一段
    if (author && text.startsWith(`${author}:`)) text = text.slice(author.length + 1).trim()
    if (!text) continue
    if (text.length > MAX_NOTE_LEN) text = `${text.slice(0, MAX_NOTE_LEN)}…`
    out.push({ ...at, text, ...(author ? { author } : {}) })
    if (out.length >= MAX_NOTES) break
  }
  return out
}

// ---------- 底色 ----------

/** Excel 的 64 色索引调色板（indexed="n" 的颜色），8 以前和 8~15 一样 */
// prettier-ignore
const INDEXED = ['000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF','000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF','800000','008000','000080','808000','800080','008080','C0C0C0','808080','9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF','000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF','00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99','3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696','003366','339966','003300','333300','993300','993366','333399','333333']

/** 主题色：theme1.xml 的 clrScheme，按 Excel 的序号排（0 浅 1 深 2 浅 2 3 深 2，4~9 强调色 1~6，10、11 超链接） */
export function themeColors(themeXml: string): string[] {
  const scheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(themeXml)?.[1]
  if (!scheme) return []
  const pick = (name: string) => {
    const m = new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`).exec(scheme)?.[1] ?? ''
    return (
      /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/.exec(m)?.[1] ??
      /lastClr="([0-9A-Fa-f]{6})"/.exec(m)?.[1] ??
      ''
    ).toUpperCase()
  }
  return [
    'lt1',
    'dk1',
    'lt2',
    'dk2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
  ].map(pick)
}

/** Excel 的 tint：正数往白调、负数往黑调，在 HSL 的亮度上算 */
function applyTint(hex: string, tint: number) {
  if (!tint) return hex
  const n = parseInt(hex, 16)
  let r = ((n >> 16) & 255) / 255
  let g = ((n >> 8) & 255) / 255
  let b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  if (s === 0) r = g = b = l
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue(p, q, h + 1 / 3)
    g = hue(p, q, h)
    b = hue(p, q, h - 1 / 3)
  }
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

function colorOf(tag: string, theme: string[]): string | undefined {
  const rgb = attr(tag, 'rgb')
  let hex: string | undefined
  if (rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb)) hex = rgb.slice(-6).toUpperCase()
  else if (attr(tag, 'theme') !== undefined) hex = theme[Number(attr(tag, 'theme'))] || undefined
  else if (attr(tag, 'indexed') !== undefined) hex = INDEXED[Number(attr(tag, 'indexed'))]
  if (!hex) return undefined
  return applyTint(hex, Number(attr(tag, 'tint') ?? 0) || 0)
}

/**
 * 每个单元格样式（cellXfs 的序号）的实心底色：#rrggbb，没有底色、白底的是 undefined。
 * 白底不算：很多表整张刷成白底，当「标记」只会到处都是白条
 */
export function fillStyles(stylesXml: string, themeXml: string): (string | undefined)[] {
  const x = noPrefix(stylesXml)
  const theme = themeColors(themeXml)
  const fills: (string | undefined)[] = []
  const fillBlock = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(x)?.[1] ?? ''
  for (const m of fillBlock.matchAll(/<fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/fill>)/g)) {
    const inner = m[1] ?? ''
    const pat = /<patternFill\b([^>]*)(?:\/>|>([\s\S]*?)<\/patternFill>)/.exec(inner)
    if (!pat || attr(pat[1], 'patternType') !== 'solid') {
      fills.push(undefined)
      continue
    }
    const fg = /<fgColor\b([^>]*)\/?>/.exec(pat[2] ?? '')?.[1]
    const hex = fg ? colorOf(fg, theme) : undefined
    fills.push(hex && hex !== 'FFFFFF' ? `#${hex.toLowerCase()}` : undefined)
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(x)?.[1] ?? ''
  const out: (string | undefined)[] = []
  for (const m of xfs.matchAll(/<xf\b([^>]*)>/g)) out.push(fills[Number(attr(m[1], 'fillId') ?? 0)])
  return out
}

/**
 * 收一张表每行的底色：读格子时每一格（含没有值、只有样式的格子）报一次样式。
 * 一行里带样式的格子过半是同一种底色、并且至少两格（单列的表一格就算）时，这一行算这个底色；
 * 整行设了样式（<row s customFormat>）的直接算
 */
export function rowFillCollector(styles: (string | undefined)[]) {
  const any = styles.some(Boolean)
  const out: SheetRowFill[] = []
  let row = -1
  let total = 0
  let rowColor: string | undefined
  const counts = new Map<string, number>()
  const flush = () => {
    if (row < 0) return
    let color = rowColor
    if (!color && total) {
      let best = 0
      for (const [c, n] of counts)
        if (n > best) {
          best = n
          color = c
        }
      if (!(best * 2 > total && (best >= 2 || total === 1))) color = undefined
    }
    if (color) out.push({ r: row, color })
    counts.clear()
    total = 0
    rowColor = undefined
  }
  return {
    /** 样式表里没有任何底色时不用收，读格子时整段跳过 */
    active: any,
    row(r: number, tag: string) {
      flush()
      row = r
      if (/\bcustomFormat="(1|true)"/.test(tag)) rowColor = styles[Number(attr(tag, 's') ?? -1)]
    },
    cell(tag: string) {
      total++
      const s = tag.includes(' s="') ? attr(tag, 's') : undefined
      const color = s === undefined ? undefined : styles[Number(s)]
      if (color) counts.set(color, (counts.get(color) ?? 0) + 1)
    },
    done(): SheetRowFill[] {
      flush()
      row = -1
      return out
    },
  }
}

/** 一张表的显示信息：sheetXml 已经去掉命名空间前缀；read 读 zip 里的文件（没有返回空串） */
export function sheetLook(
  sheetXml: string,
  sheetFile: string,
  read: (name: string) => string,
  fills: SheetRowFill[],
): SheetLook | undefined {
  const look: SheetLook = {}
  const merges = readMerges(sheetXml)
  if (merges.length) look.merges = merges
  const relsName = path.posix.join(path.posix.dirname(sheetFile), '_rels', `${path.posix.basename(sheetFile)}.rels`)
  const hasLinks = sheetXml.includes('<hyperlink')
  // 批注挂在工作表的 rels 上（…/relationships/comments），没有 rels 就没有批注和外部链接
  const relsXml = read(relsName)
  if (relsXml || hasLinks) {
    const rels = sheetRels(relsXml, sheetFile)
    if (hasLinks) {
      const links = readLinks(sheetXml, rels)
      if (links.length) look.links = links
    }
    const notes: SheetNote[] = []
    for (const rel of rels.values())
      if (!rel.external && /\/comments$/.test(rel.type)) notes.push(...readNotes(read(rel.target)))
    if (notes.length) look.notes = notes.slice(0, MAX_NOTES)
  }
  if (fills.length) look.fills = fills
  return Object.keys(look).length ? look : undefined
}
