/**
 * 老对话里主 Agent 写过的 dispatch 代码块：主 Agent 去掉了（workflow-runs 设计 D1），新的执行不会再出现，
 * 只在显示老消息时把这些代码块去掉
 */

/** 主 Agent 回复里写决定的代码块语言名 */
const DISPATCH_LANG = 'dispatch'

// 语言名后面可以跟别的字（```dispatch json），JSON 也可能和语言名写在同一行
const BLOCK = new RegExp('```' + DISPATCH_LANG + '\\b[^\\n{]*\\n?([\\s\\S]*?)```', 'g')

/** 显示时去掉 dispatch 代码块；流式输出到一半时去掉到结尾 */
export function stripDispatch(text: string) {
  if (!text.includes('```' + DISPATCH_LANG)) return text
  return text
    .replace(BLOCK, '')
    .replace(new RegExp('```' + DISPATCH_LANG + '\\b[\\s\\S]*$'), '')
    .trimEnd()
}
