/**
 * 工作总结报告里「分点」和「关键代码」的处理（ADR 0056）：
 *
 * - 分点：CLI 交回的 content / cause / fix 是数组（老格式是一段话），存成每行一点，报告里按序号一项项写；
 * - 关键代码：Bug 条目附的代码只收材料里真实改动过的行，CLI 改写或编出来的那段整段丢掉，不让报告里出现假代码。
 *
 * 纯逻辑，提示词和拼报告在 shared/summary.ts
 */
import { z } from 'zod'

/** 关键代码每段最多多少字、每条分项最多几段：用户要求不限段数，这个上限只是防止数据无限长 */
export const SUMMARY_CODE_CHARS = 3000
export const SUMMARY_CODE_MAX = 20

/**
 * Bug 条目附的一段关键代码：文件相对路径、代码块的语言、带注释的代码。
 * 只收这段时间真实改动里出现过的代码（见 codeFromMaterial），不让 CLI 编
 */
export const SummaryCode = z.object({
  file: z.string().trim().max(300).default(''),
  lang: z.string().trim().max(20).default(''),
  text: z.string().max(SUMMARY_CODE_CHARS),
})
export type SummaryCode = z.infer<typeof SummaryCode>

/** 一点开头 CLI 自己加的序号或列表符号（「1.」「2、」「- 」）：报告统一加序号，这里去掉免得出现「1. 1.」 */
const BULLET = /^\s*(?:\d+[.、)）]|[-*•])\s*/

/**
 * 把 CLI 给的分点整理成每行一点：数组按元素、字符串按行拆开，每点先过 clean（去 AI 符号、压成一行），
 * 空的丢掉，按 max 字截断整段
 */
export function joinPoints(v: unknown, clean: (s: string) => string, max: number) {
  const raw = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []
  const list = raw
    .flatMap((x) => x.split('\n'))
    .map((x) => clean(x.replace(BULLET, '')))
    .filter(Boolean)
  return list.join('\n').slice(0, max).trim()
}

/** 存下来的分点拆回一行一点（老报告的一段话就是一点） */
export const splitPoints = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)

/** 只有注释的行：报告要求加的注释本来就不在改动里，校验时跳过 */
const COMMENT = /^(?:\/\/|\/\*|\*\/?|#|<!--|--\s|;)/

/** 校验用的一行代码：压掉空白，diff 的 +/- 号去掉，行尾 // 注释去掉（CLI 常把注释写在行尾） */
function norm(line: string, diff: boolean) {
  let x = line
  if (diff) x = x.replace(/^[+\- ]/, '')
  x = x.replace(/\s+\/\/\s.*$/, '')
  return x.replace(/\s+/g, ' ').trim()
}

/**
 * 材料里出现过的代码行（压掉空白后）：差异行去掉开头的 +/-/空格，原样的行也收（来源是报告时代码在旧报告的代码块里）
 */
export function materialLines(material: string): Set<string> {
  const out = new Set<string>()
  for (const line of material.split('\n')) {
    const a = norm(line, false)
    const b = norm(line, true)
    if (a) out.add(a)
    if (b) out.add(b)
  }
  return out
}

/** CLI 偶尔把代码再包一层 ``` 代码块：去掉首尾的围栏 */
function unfence(text: string) {
  return text.replace(/^\s*```[\w-]*\n/, '').replace(/\n```\s*$/, '')
}

/**
 * 从 CLI 的 code 字段取关键代码：每段除注释外的每一行都要在材料里出现过，有一行对不上就整段丢掉
 * （改写过的、补全的、编出来的都算对不上）；只有注释没有代码的也丢掉。不限段数，SUMMARY_CODE_MAX 只防数据无限长
 */
export function codeFromMaterial(v: unknown, known: Set<string>): SummaryCode[] {
  if (!Array.isArray(v)) return []
  const out: SummaryCode[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const r = x as Record<string, unknown>
    if (typeof r.text !== 'string') continue
    const lang = typeof r.lang === 'string' ? r.lang.trim().slice(0, 20) : ''
    const text = unfence(r.text).replace(/\s+$/, '')
    if (!text.trim() || text.length > SUMMARY_CODE_CHARS) continue
    const diff = lang === 'diff'
    const lines = text
      .split('\n')
      .map((l) => norm(l, diff))
      .filter((l) => l && !COMMENT.test(l))
    if (!lines.length || !lines.every((l) => known.has(l))) continue
    out.push({ file: typeof r.file === 'string' ? r.file.trim().slice(0, 300) : '', lang, text })
    if (out.length >= SUMMARY_CODE_MAX) break
  }
  return out
}

/** 报告里的一段代码：文件路径一行，下面是代码块；代码里本身有 ``` 时外层用更长的围栏 */
export function codeBlock(c: SummaryCode) {
  const fence = c.text.includes('```') ? '````' : '```'
  return [...(c.file ? [`\`${c.file}\``] : []), `${fence}${c.lang}`, c.text, fence]
}
