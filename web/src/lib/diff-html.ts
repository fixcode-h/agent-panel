/**
 * 所有 diff 的统一画法（用户 2026-11-10 要求「改成 Claude Code 的一样，所有用到 diff 的都改」）：
 * 一列行号（加的行和上下文写改后的行号，删的行写改前的），一列 +/− 记号，然后是去掉开头记号的代码；
 * 加的行绿底、删的行红底，行号槽深一层；不画 `@@ -1,2 +1,3 @@` 段头，段与段之间是一条「⋯ 第 n 行」的浅底窄行；
 * 给了文件名就按它的语言着色。行号和记号选不中，复制、标注都只带代码。
 * 这里只出 HTML 字符串：Markdown 代码块（workflow-doc.ts）直接拼进去，界面组件（components/ui/UnifiedDiff.tsx）
 * 用 dangerouslySetInnerHTML 挂上，样式只有 index.css 的 .cdiff 一套
 */
import { t } from '@shared/i18n'
import { langOf, type Hljs } from './file-highlight-core'

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'note'
  text: string
  /** 这一行显示的行号：加的行、上下文是改后的，删的行是改前的 */
  n?: number
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** 文件头：不显示 */
const HEAD =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename (from|to) |old mode|new mode|Binary files )/

/**
 * unified diff 拆成行。strict：碰到不认识的行（不是 +/−/空格开头）返回 null，Markdown 里拿它判断是不是真的 diff；
 * 不 strict 时当成上下文。没有 @@ 行号的 diff（自己拼的对照）不写行号
 */
export function parseDiff(text: string, strict = false): DiffRow[] | null {
  const out: DiffRow[] = []
  let a = 0
  let b = 0
  let numbered = false
  for (const l of text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')) {
    if (HEAD.test(l)) continue
    if (l.startsWith('\\')) {
      out.push({ kind: 'note', text: l.replace(/^\\\s*/, '') })
      continue
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l)
    if (h) {
      a = Number(h[1])
      b = Number(h[2])
      numbered = true
      out.push({ kind: 'hunk', text: h[3].trim(), n: b || a })
      continue
    }
    if (l.startsWith('@@')) {
      numbered = false
      out.push({ kind: 'hunk', text: '' })
      continue
    }
    const c = l[0]
    if (c === '+') out.push({ kind: 'add', text: l.slice(1), n: numbered ? b++ : undefined })
    else if (c === '-') out.push({ kind: 'del', text: l.slice(1), n: numbered ? a++ : undefined })
    else if (c === ' ' || l === '') {
      out.push({ kind: 'ctx', text: l.slice(1), n: numbered ? b : undefined })
      if (numbered) {
        a++
        b++
      }
    } else if (strict) return null
    else out.push({ kind: 'ctx', text: l })
  }
  return out
}

/** 段头 `@@ -48,9 +48,8 @@ fn()` 的显示：「⋯ 第 48 行  fn()」（左右对照的差异弹窗用，和 diffRowsHtml 一个说法） */
export function hunkLabel(l: string): string {
  const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l)
  if (!h) return '⋯'
  const ctx = h[3].trim()
  return `⋯ ${t('第 {n} 行', { n: Number(h[2]) || Number(h[1]) })}${ctx ? `  ${ctx}` : ''}`
}

/** 增删行数 */
export const diffCounts = (rows: DiffRow[]) => ({
  add: rows.filter((r) => r.kind === 'add').length,
  del: rows.filter((r) => r.kind === 'del').length,
})

/** 高亮后的 HTML 按行切开：跨行的 span 在行尾关上、下一行开头重新打开 */
function splitHtml(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let cur = ''
  for (const [s] of html.matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g)) {
    if (s === '\n') {
      lines.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
      continue
    }
    if (s === '</span>') open.pop()
    else if (s.startsWith('<span')) open.push(s)
    cur += s
  }
  lines.push(cur)
  return lines
}

/** 着色最多这么多字：再长的整段按纯文本画，不让高亮拖慢弹窗 */
const HL_MAX = 200_000

/**
 * 画出行（不含外框）：hl 是加载好的 highlight.js（没加载就是纯文本），file 认语言用；
 * max 只画前这么多行（差异弹窗分批显示）
 */
export function diffRowsHtml(rows: DiffRow[], opts: { hl?: Hljs | null; file?: string; max?: number } = {}): string {
  const shown = opts.max === undefined ? rows : rows.slice(0, opts.max)
  const code = shown.filter((r) => r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx')
  let html = code.map((r) => escape(r.text))
  const lang = opts.file ? langOf(opts.hl ?? null, opts.file) : ''
  const joined = code.map((r) => r.text).join('\n')
  if (opts.hl && lang && joined.length < HL_MAX)
    try {
      const lines = splitHtml(opts.hl.highlight(joined, { language: lang, ignoreIllegals: true }).value)
      if (lines.length === code.length) html = lines
    } catch {
      // 高亮失败就显示原文
    }
  const numbered = rows.some((r) => r.n !== undefined && r.kind !== 'hunk')
  let k = 0
  return shown
    .map((r, i) => {
      if (r.kind === 'hunk') {
        // 从第 1 行开始的第一段前面没省略什么，不画分隔
        if (i === 0 && (r.n ?? 1) <= 1) return ''
        const at = r.n ? escape(t('第 {n} 行', { n: r.n })) : ''
        const ctx = r.text ? `<span class="cdiff-ctx">${escape(r.text)}</span>` : ''
        return `<div class="cdiff-row cdiff-hunk" aria-hidden="true">⋯${at ? ` ${at}` : ''}${ctx}</div>`
      }
      if (r.kind === 'note') return `<div class="cdiff-row cdiff-note">${escape(r.text)}</div>`
      const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''
      const num = numbered ? `<span class="cdiff-n" aria-hidden="true">${r.n ?? ''}</span>` : ''
      return `<div class="cdiff-row cdiff-${r.kind}">${num}<span class="cdiff-s" aria-hidden="true">${sign}</span><span class="cdiff-c">${html[k++] || ' '}</span></div>`
    })
    .filter(Boolean)
    .join('')
}

/** 增删数的小标签：+3 绿、−1 红（顶栏用） */
export const diffStatHtml = (add: number, del: number) =>
  `<span class="cdiff-stat"><span class="cdiff-stat-add">+${add}</span> <span class="cdiff-stat-del">−${del}</span></span>`

/**
 * Markdown 里的 ```diff 代码块：信息串里的 file=（URL 编码）写进顶栏、按语言着色；
 * 认不出是 unified diff（夹着别的文字）返回 null，调用方照普通代码块画
 */
export function markdownDiff(
  text: string,
  info: string,
  hl: Hljs | null,
  bar: (name: string, count: number, extra: string) => string,
): string | null {
  const rows = parseDiff(text, true)
  if (!rows || !rows.some((r) => r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx')) return null
  let file = ''
  try {
    file = decodeURIComponent(/(?:^|\s)file=(\S+)/.exec(info)?.[1] ?? '')
  } catch {}
  const { add, del } = diffCounts(rows)
  const name = file ? (file.split('/').at(-1) ?? file) : 'diff'
  const title = file ? ` title="${escape(file)}"` : ''
  // data-src 是原文：「复制」复制整段 diff（Markdown.tsx），不是画出来带行号的样子
  return `<div class="md-code md-diff" data-lines="${rows.length}" data-src="${escape(text)}"${title}>${bar(name, 0, diffStatHtml(add, del))}<div class="cdiff"><div class="cdiff-in">${diffRowsHtml(rows, { hl, file })}</div></div></div>`
}
