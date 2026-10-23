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

/** 文件的变更统计：增删行数和差异块（@@）数量 */
export interface DiffStats {
  add: number
  del: number
  hunks: number
}

/** 数一遍 diff 里的增行、删行和差异块。文件头（diff / index / --- / +++）不算 */
export function diffStats(lines: string[]): DiffStats {
  const out: DiffStats = { add: 0, del: 0, hunks: 0 }
  for (const l of lines) {
    if (lineClass(l) === null) continue
    if (l.startsWith('@@')) out.hunks++
    else if (l.startsWith('+')) out.add++
    else if (l.startsWith('-')) out.del++
  }
  return out
}

/** 行内高亮的一段：changed 的部分是这一行真正改动的位置 */
export interface InlinePart {
  text: string
  changed?: boolean
}

/** 超过这个长度的行不做逐字符比对：超长行（压缩后的资源、单行 JSON）比对没有意义，还可能拖慢渲染 */
const INLINE_MAX = 4000

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * 一对修改行的行内差异：去掉公共前缀、后缀，中间那段就是改动。
 * 只按字符比，不做 LCS——逐行看差异时这样已经够用，而且不会因为长行（几千个字符）卡住。
 * 切分点落在代理对（emoji 这类）中间时往回退一格，避免把一个字符拆成两半显示成乱码。
 */
export function inlineDiff(a: string, b: string): { left: InlinePart[]; right: InlinePart[] } {
  if (a === b || a.length > INLINE_MAX || b.length > INLINE_MAX) return { left: [{ text: a }], right: [{ text: b }] }
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a[p] === b[p]) p++
  if (p > 0 && p < a.length && isLowSurrogate(a.charCodeAt(p))) p--
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  if (s > 0 && isLowSurrogate(a.charCodeAt(a.length - s))) s--
  const left: InlinePart[] = []
  const right: InlinePart[] = []
  const leftMid = a.slice(p, a.length - s)
  const rightMid = b.slice(p, b.length - s)
  if (p) {
    left.push({ text: a.slice(0, p) })
    right.push({ text: b.slice(0, p) })
  }
  if (leftMid) left.push({ text: leftMid, changed: true })
  if (rightMid) right.push({ text: rightMid, changed: true })
  if (s) {
    left.push({ text: a.slice(a.length - s) })
    right.push({ text: b.slice(b.length - s) })
  }
  return { left, right }
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
