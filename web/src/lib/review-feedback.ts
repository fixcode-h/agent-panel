/** 标注里引用的原文太长时只带开头，Agent 靠这一段就能找到位置 */
const QUOTE_MAX = 300

/**
 * 退回修改时交给 Agent 的意见：逐条「原文 + 意见」，最后是整体意见。
 * 这是发给 Agent 的提示词，不翻译
 */
export function reviewFeedback(notes: { quote: string; comment: string }[], overall: string) {
  const lines: string[] = []
  if (notes.length) {
    lines.push('请按下面的标注修改：', '')
    notes.forEach((n, i) => {
      const q = n.quote.replace(/\s+/g, ' ').trim()
      lines.push(`${i + 1}. 原文：「${q.length > QUOTE_MAX ? q.slice(0, QUOTE_MAX) + '…' : q}」`)
      lines.push(`   意见：${n.comment.trim() || '（标注了这里，没写具体意见，请重新斟酌这一处）'}`)
    })
  }
  if (overall.trim()) {
    if (lines.length) lines.push('')
    lines.push(`整体意见：${overall.trim()}`)
  }
  return lines.join('\n')
}
