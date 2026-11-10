/**
 * 文件弹窗的表格视图用的纯函数：把 CSV / TSV 文字拆成「行 × 列」、列名、列宽估算、在单元格里搜索。
 * xlsx 由服务端解析好（server/xlsx.ts），到页面上和 CSV 是同一种数据（string[][]），共用一个表格（SheetTable）。
 */
import { HIT_MAX } from './file-search'

/** 阅读时按表格显示的文字文件 */
export const isCsvPath = (path: string) => /\.(csv|tsv)$/i.test(path)

/** 猜分隔符：看第一行里逗号、分号、制表符哪个多（引号里的不算）；欧洲区的 Excel 导出的 CSV 用分号 */
export function sniffDelimiter(text: string) {
  const count: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && ch in count) count[ch]++
  }
  return count['\t'] > count[','] && count['\t'] >= count[';'] ? '\t' : count[';'] > count[','] ? ';' : ','
}

/**
 * 拆 CSV：引号里可以有分隔符和换行，两个引号是一个引号；\r\n、\n、\r 都算换行。
 * 一遍扫完（文件弹窗里处理整份内容必须是线性的，见 docs/lessons/file-view.md），结尾的空行不要。
 */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const n = text.length
  while (i < n) {
    let cell = ''
    if (text[i] === '"') {
      i++
      let from = i
      for (;;) {
        const q = text.indexOf('"', i)
        if (q < 0) {
          // 引号没闭合：剩下的都算这一格
          cell += text.slice(from)
          i = n
          break
        }
        if (text[q + 1] === '"') {
          cell += text.slice(from, q + 1)
          i = from = q + 2
          continue
        }
        cell += text.slice(from, q)
        i = q + 1
        break
      }
      // 闭合引号后面到分隔符之间的字（不规范的写法）照样接上
      from = i
      while (i < n && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') i++
      cell += text.slice(from, i)
    } else {
      const from = i
      while (i < n && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') i++
      cell = text.slice(from, i)
    }
    row.push(cell)
    if (i >= n) break
    if (text[i] === delimiter) {
      i++
      // 分隔符后面就结束了：最后还有一个空格子
      if (i >= n) row.push('')
      continue
    }
    if (text[i] === '\r' && text[i + 1] === '\n') i++
    i++
    rows.push(row)
    row = []
  }
  if (row.length) rows.push(row)
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop()
  return rows
}

/** 第几列 → Excel 的列名（0 → A，26 → AA） */
export function colName(index: number) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** 一共多少列：各行长短不一，取最长的 */
export function colCount(rows: string[][]) {
  let n = 0
  for (const r of rows) if (r.length > n) n = r.length
  return n
}

/** 估列宽只看前面这么多行：一万行的表不值得为了列宽全扫一遍 */
const WIDTH_SAMPLE = 300
const MIN_W = 56
const MAX_W = 320

/**
 * 每列的宽度（px）：按前面一些行里最长的那一格估，中日韩文字比英文字母宽（界面默认是等宽字体，12px 下英文约 7.4px、中文 12px）；太长的格子截断显示，悬停看全。
 * 表格是虚拟滚动的，屏幕外的行不在页面里，没法让浏览器自己排列宽。
 */
export function colWidths(rows: string[][], cols = colCount(rows)): number[] {
  const units = Array.from<number>({ length: cols }).fill(0)
  const end = Math.min(rows.length, WIDTH_SAMPLE)
  for (let r = 0; r < end; r++) {
    const row = rows[r]
    for (let c = 0; c < row.length; c++) {
      const s = row[c]
      // 只量第一行、最多 60 个字：反正超过上限就截断
      let u = 0
      for (let i = 0; i < s.length && i < 60; i++) {
        const code = s.charCodeAt(i)
        if (code === 10) break
        u += code > 0x2e7f ? 1.7 : 1
      }
      if (u > units[c]) units[c] = u
    }
  }
  return units.map((u) => Math.max(MIN_W, Math.min(MAX_W, Math.round(u * 7.4) + 20)))
}

/** 命中的一格 */
export interface CellHit {
  row: number
  col: number
}

/** 在表格里找：哪些格子里有这个词（一格算一处），按行、列的顺序 */
export function findCells(rows: string[][], query: string, caseSensitive: boolean): CellHit[] {
  if (!query) return []
  const needle = caseSensitive ? query : query.toLowerCase()
  const out: CellHit[] = []
  for (let r = 0; r < rows.length && out.length < HIT_MAX; r++) {
    const row = rows[r]
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      if (!cell) continue
      if ((caseSensitive ? cell : cell.toLowerCase()).includes(needle)) out.push({ row: r, col: c })
    }
  }
  return out
}
