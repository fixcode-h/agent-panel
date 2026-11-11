/**
 * CSV / TSV 的拆分和写回（纯函数，前后端共用）：文件弹窗、表格页按表格看，表格页改完按原来的写法写回。
 */

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

/** 一格要不要加引号：有分隔符、引号、换行（开头结尾的空格读的时候原样留着，写回也不加引号，和 Excel 一样） */
const needQuote = (cell: string, delimiter: string) =>
  cell.includes(delimiter) || cell.includes('"') || /[\r\n]/.test(cell)

/** 写回 CSV：只在需要时加引号（和 Excel 存出来的一样），分隔符、换行符、BOM、结尾换行都按原文件 */
export function writeCsv(
  rows: string[][],
  opts: { delimiter: string; eol: 'lf' | 'crlf'; bom: boolean; trailingEol?: boolean },
): string {
  const nl = opts.eol === 'crlf' ? '\r\n' : '\n'
  const text = rows
    .map((r) => r.map((c) => (needQuote(c, opts.delimiter) ? `"${c.replace(/"/g, '""')}"` : c)).join(opts.delimiter))
    .join(nl)
  return (opts.bom ? '\ufeff' : '') + text + (opts.trailingEol === false ? '' : nl)
}

/** 读 CSV 的写法：分隔符、换行、有没有 BOM、结尾有没有换行 */
export function csvFormat(text: string, tsv = false) {
  return {
    delimiter: tsv ? '\t' : sniffDelimiter(text),
    eol: (text.includes('\r\n') ? 'crlf' : 'lf') as 'lf' | 'crlf',
    bom: text.charCodeAt(0) === 0xfeff,
    trailingEol: /\n$/.test(text),
  }
}
