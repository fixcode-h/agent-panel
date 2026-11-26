/**
 * find 一次查几个词（设计稿「技能与自建工具按情境加载」15.3 方案 B）：query 给数组时每个词各查一遍（同时查），结果按词分组。
 * 为什么做：弱模型找三个函数会一个一个调，每次多一轮模型请求；并行调用（方案 A）它未必照做，收数组是同一个工具里就能省掉的。
 * 总长度照 ADR 0067 的返回预算（4000 字）按组平分：一组用不完的让给后面的，截掉的那组末尾写清怎么单独查全
 */

/** 一次最多几个词：再多每组分到的字数太少，看不出东西 */
export const MULTI_MAX = 10
const BUDGET = 4000

/** query 是数组且不止一个词时返回这些词（去空、去重）；单个词、字符串返回 undefined，照单个查 */
export function multiQueries(v: unknown): string[] | string | undefined {
  if (!Array.isArray(v)) return undefined
  const qs = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))]
  if (qs.length > MULTI_MAX) return `query 一次最多 ${MULTI_MAX} 个词，分几次查`
  return qs.length > 1 ? qs : undefined
}

/** 每组一段「## 词」；按预算截，至少每组留标题和一行 */
export function joinGroups(groups: { query: string; text: string }[], budget = BUDGET): string {
  let left = budget
  return groups
    .map((g, i) => {
      const share = Math.floor(left / (groups.length - i))
      const head = `## ${g.query}`
      const lines = g.text.split('\n')
      const out: string[] = [head]
      let used = head.length
      for (const l of lines) {
        if (out.length > 1 && used + l.length + 1 > share) {
          out.push(`（这一组没列完：单独查 query="${g.query}"，按末尾的 offset 往下翻）`)
          break
        }
        out.push(l)
        used += l.length + 1
      }
      const s = out.join('\n')
      left -= s.length
      return s
    })
    .join('\n\n')
}
