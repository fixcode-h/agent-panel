/**
 * 差异行数据的整理：从 unified diff 文本推出每行的样式和左右对照的配对。
 * 纯数据、不碰样式类以外的界面细节，方便直接写单元测试（DiffDialog 只负责画）。
 */

/** 一行差异的样式：新增绿、删除红、块头灰，文件头返回 null（不显示） */
export function lineClass(l: string): string | null {
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) return null
  if (l.startsWith('new file') || l.startsWith('deleted file') || l.startsWith('similarity')) return null
  if (l.startsWith('@@')) return 'bg-field text-subtle'
  if (l.startsWith('+')) return 'bg-success/10 text-success'
  if (l.startsWith('-')) return 'bg-danger/10 text-danger'
  return 'text-muted'
}

/** 上下对照的一行：cls 是整行的样式，a / b 是改前、改后的行号 */
export interface NumberedLine {
  l: string
  cls: string
  a?: number
  b?: number
}

/** 给每行配上改前、改后的行号（从 @@ -a,n +b,m @@ 推出来）；文件头那几行不显示 */
export function numbered(lines: string[]): NumberedLine[] {
  let a = 0
  let b = 0
  const out: NumberedLine[] = []
  for (const l of lines) {
    const cls = lineClass(l)
    if (cls === null) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (h) {
      a = Number(h[1])
      b = Number(h[2])
      out.push({ l, cls })
    } else if (l.startsWith('+')) out.push({ l, cls, b: b++ })
    else if (l.startsWith('-')) out.push({ l, cls, a: a++ })
    else if (l.startsWith('\\')) out.push({ l, cls })
    else out.push({ l, cls, a: a++, b: b++ })
  }
  return out
}

/** 左右对照的一行：块头 / 说明占整行，pair 的某一侧缺省表示只在另一侧出现 */
export type Row =
  | { kind: 'hunk'; l: string }
  | { kind: 'note'; l: string }
  | { kind: 'pair'; left?: { n: number; l: string }; right?: { n: number; l: string } }

/**
 * 把 unified diff 排成左右对照：一段连续的删行接一段连续的增行，按位置配对，多出来的那侧留空。
 * 行号沿用 @@ 里给的数，只用来显示。缺失的一侧不标红绿：新增文件整条左栏不该是红的。
 */
export function sideBySide(lines: string[]): Row[] {
  let a = 0
  let b = 0
  const out: Row[] = []
  // 连续的删行和增行先攒着，遇到上下文行或块结束时配对
  let dels: { n: number; l: string }[] = []
  let adds: { n: number; l: string }[] = []
  const flush = () => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) out.push({ kind: 'pair', left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (lineClass(l) === null) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (h) {
      flush()
      a = Number(h[1])
      b = Number(h[2])
      out.push({ kind: 'hunk', l })
    } else if (l.startsWith('-')) dels.push({ n: a++, l: l.slice(1) })
    else if (l.startsWith('+')) adds.push({ n: b++, l: l.slice(1) })
    else if (l.startsWith('\\')) {
      flush()
      out.push({ kind: 'note', l })
    } else {
      flush()
      const text = l.slice(1)
      out.push({ kind: 'pair', left: { n: a++, l: text }, right: { n: b++, l: text } })
    }
  }
  flush()
  return out
}
