/**
 * 日志引用的行号校准：Agent 写的 start~end 那几行里没有它抄的原文或关键值（highlight）时，在附近找一段都对得上的挪过去，
 * 并告诉 Agent 挪到了哪。和关键代码按 marks.text 校准行号一个道理（quotes.ts 的 resolveRef）。
 * 起因（实跑 2026-11-18）：Agent 用 `sed -n '110650,111530p' 日志 | rg -n 关键词` 读大日志，rg 打出的是相对行号，
 * 换算回文件行号时算错了 34 行，highlight 对不上被退回，连同别的退回三次用完、报告没交上去。
 * 只放纯函数：取行由调用方给（文件按行读、用户贴的日志直接切）
 */
import type { BugQuote } from './diagnosis-schema.ts'

/** 往上下各找这么多行：相对行号算错一般差几十行，太远的多半是另一次运行，不挪 */
export const LOG_NEAR = 2000

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 这段原文对得上 Agent 写的：抄的原文逐字（空白归一）在里面，关键值都在里面 */
export function quoteFits(q: Pick<BugQuote, 'text' | 'highlight'>, text: string): boolean {
  if (q.text.trim() && !norm(text).includes(norm(q.text))) return false
  return q.highlight.every((h) => !h.trim() || text.includes(h))
}

/**
 * 对不上时在 ±LOG_NEAR 行里找离原位置最近、原文和关键值都对得上的一段（行数不变），挪过去返回 true。
 * 没写原文也没写关键值的没法校准；找不到返回 false，由调用方照原来的话退回。
 * cut(a, b) 取第 a~b 行（行号从 1 起，越界的部分不返回）
 */
export function shiftQuote(
  q: BugQuote,
  current: string,
  cut: (start: number, end: number) => string | undefined,
  notes: string[],
): boolean {
  const start = q.start ?? 0
  const end = q.end ?? start
  if (!start || quoteFits(q, current)) return false
  if (!q.text.trim() && !q.highlight.some((h) => h.trim())) return false
  const from = Math.max(1, start - LOG_NEAR)
  const window = cut(from, end + LOG_NEAR)
  if (window === undefined) return false
  const lines = window.split(/\r\n?|\n/)
  const len = end - start + 1
  const fitsAt = (s: number) => {
    const i = s - from
    return i >= 0 && i + len <= lines.length && quoteFits(q, lines.slice(i, i + len).join('\n'))
  }
  for (let d = 1; d <= LOG_NEAR; d++)
    for (const s of [start + d, start - d]) {
      if (s < 1 || !fitsAt(s)) continue
      notes.push(
        `${q.id} 写的第 ${start}~${end} 行对不上原文和关键值，第 ${s}~${s + len - 1} 行对得上，已按这几行引用` +
          `（行号写整个文件的行号；sed -n 'a,bp' | rg -n 打出的是相对行号，要加上 a-1）。`,
      )
      q.start = s
      q.end = s + len - 1
      return true
    }
  return false
}
