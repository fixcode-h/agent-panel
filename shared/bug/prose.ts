/**
 * 诊断报告里 Agent 写的一段段文字怎么排（shared/bug/diagnosis-md.ts 用）：模型常把几条写在一行里
 * （「① … ② …」「1) … 2) …」、「现象 ← 日志 ← 代码」、用分号隔开的一串），弹窗里挤成一大段看不清。
 * 这里只按这几种明显的分隔拆成一行一条，不改写内容；已经自己换了行的原样保留
 */

const CIRCLED = /[①-⑳]/g

/** 文件只留文件名：表格里放全路径太挤 */
export const shortFile = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? p

/** 现象、复现里常见的小标签（期望：… 实际：…）：开头或句号、分号之后出现的才算 */
const LABEL = /(?<=^|[。；;]\s*)((?:期望|实际|环境|触发|频率|版本|复现\s?[A-Z])[^：:。；;]{0,16}[：:])/g

/** 按分隔符拆开后，至少要有这么多条才拆（两条以内读起来不费劲） */
const MIN_ITEMS = 2

const items = (parts: string[]) => parts.map((s) => s.trim().replace(/[；;，,。]$/, '')).filter(Boolean)

export function prose(text: string | undefined): string {
  const s = (text ?? '').trim()
  if (!s || s.includes('\n')) return s
  // 期望：… 实际：… 环境：…、复现 A：… 复现 B：…：一个标签一行，标签加粗
  const labels = [...s.matchAll(LABEL)]
  if (labels.length >= MIN_ITEMS) {
    const lead = s.slice(0, labels[0].index).trim()
    const list = labels.map((m, i) => {
      const end = labels[i + 1]?.index ?? s.length
      const body = s
        .slice(m.index + m[0].length, end)
        .trim()
        .replace(/[。；;]$/, '')
      return `- **${m[1].trim().replace(/[：:]$/, '')}**：${body}`
    })
    return [lead, list.join('\n')].filter(Boolean).join('\n\n')
  }
  // ① … ② …：拆成编号列表（开头那段不是编号的，留作引子）
  if ((s.match(CIRCLED) ?? []).length >= MIN_ITEMS) {
    const [lead, ...rest] = s.split(CIRCLED)
    const list = items(rest)
    if (list.length >= MIN_ITEMS)
      return [lead.trim(), list.map((x, i) => `${i + 1}. ${x}`).join('\n')].filter(Boolean).join('\n\n')
  }
  // 1) … 2) … 或 1）… 2）…
  const numbered = s.split(/(?:^|\s|；|;|，|。)\(?\d{1,2}[)）]\s*/)
  if (numbered.length > MIN_ITEMS) {
    const [lead, ...rest] = numbered
    const list = items(rest)
    if (list.length >= MIN_ITEMS)
      return [lead.trim(), list.map((x, i) => `${i + 1}. ${x}`).join('\n')].filter(Boolean).join('\n\n')
  }
  // 证据链：现象 ← 日志 ← 代码，一环一行
  const chain = s.split(/\s*←\s*/)
  if (chain.length > MIN_ITEMS) return chain.map((x, i) => (i ? `- ← ${x.trim()}` : `- ${x.trim()}`)).join('\n')
  // 分号隔开的一串（三条以上、整段够长才拆）
  const semi = items(s.split(/[；;]\s*/))
  if (semi.length > MIN_ITEMS && s.length > 80) return semi.map((x) => `- ${x}`).join('\n')
  return s
}
