/**
 * 文件编辑框里的 Tab / Shift+Tab：纯函数算出要替换的区间和新的选区，
 * 由编辑框用 execCommand('insertText') 落到输入框上（这样 Ctrl+Z 还能撤销）。
 */

/** 按文件已有的缩进猜缩进单位：Tab 开头的行多就用 Tab，否则看空格缩进里最窄的一级（2 或 4），都没有时 2 个空格 */
export function indentUnit(text: string) {
  let tabs = 0
  let spaces = 0
  let min = Infinity
  for (const line of text.split('\n', 2000)) {
    if (!line.trim()) continue
    if (line.startsWith('\t')) tabs++
    else if (line.startsWith(' ')) {
      spaces++
      min = Math.min(min, line.length - line.trimStart().length)
    }
  }
  if (tabs > spaces) return '\t'
  return min >= 4 && min !== Infinity ? '    ' : '  '
}

export interface IndentEdit {
  /** 要替换掉的区间 */
  from: number
  to: number
  /** 换成的内容 */
  insert: string
  /** 换完之后的选区 */
  selStart: number
  selEnd: number
}

/** 去掉一行开头的一级缩进：一个 Tab，或最多 unit 宽的空格 */
function outdentLine(line: string, unit: string) {
  if (line.startsWith('\t')) return line.slice(1)
  const width = unit === '\t' ? 4 : unit.length
  let n = 0
  while (n < width && line[n] === ' ') n++
  return line.slice(n)
}

/**
 * 算一次缩进：没选中或只在一行里选中时，Tab 在光标处插入一级缩进（替换选中的字）；
 * 选中跨了多行、或者按 Shift+Tab 时，整行一起加 / 减一级。返回 null 表示没有可改的（例如没缩进的行再减）
 */
export function indentEdit(
  text: string,
  selStart: number,
  selEnd: number,
  outdent: boolean,
  unit: string,
): IndentEdit | null {
  const multi = text.slice(selStart, selEnd).includes('\n')
  if (!outdent && !multi) {
    return {
      from: selStart,
      to: selEnd,
      insert: unit,
      selStart: selStart + unit.length,
      selEnd: selStart + unit.length,
    }
  }
  const from = text.lastIndexOf('\n', selStart - 1) + 1
  // 选区结束在下一行行首时，那一行不算在内（和常见编辑器一样）
  const last = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd
  const nl = text.indexOf('\n', last)
  const to = nl < 0 ? text.length : nl
  const lines = text.slice(from, to).split('\n')
  const next = lines.map((l) => (outdent ? outdentLine(l, unit) : l.trim() ? unit + l : l))
  const insert = next.join('\n')
  if (insert === text.slice(from, to)) return null
  // 选区起点：从行首开始选的还停在行首（整行选中的样子不变）；在行中间的跟着这一行的缩进挪，但不挪到行首前面
  const firstDelta = next[0].length - lines[0].length
  const start = selStart === from && multi ? from : Math.max(from, selStart + firstDelta)
  const end = selEnd + (insert.length - (to - from))
  return { from, to, insert, selStart: start, selEnd: Math.max(start, end) }
}
