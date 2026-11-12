import type { ApiProtocol } from '../accounts.ts'

/** 大请求约多少字：按英文每 4 个字符约 1 个 token，约 2 万 token，接近 Agent 带着工具定义和几轮上下文时的一次请求 */
export const LARGE_CHARS = 80_000

/** API 测速的一行（设置 › API 的「测速」，请求在 server/cli/api-speed.ts 里发）：前后端共用 */
export interface SpeedRow {
  protocol: ApiProtocol
  size: 'small' | 'large'
  /** 从发出到第一段模型输出（思考或正文） */
  firstMs?: number
  totalMs?: number
  error?: string
}

/** 大请求的正文：一段固定的英文说明重复到指定长度，末尾问一句（每次一样，前后几次结果可比） */
export function largePrompt(chars = LARGE_CHARS) {
  const unit =
    'The panel schedules local coding agents for each project and runs them along a workflow graph. ' +
    'Each step sends the whole conversation, tool definitions and recent tool results back to the model. '
  return `${unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)}\n\nReply with one short sentence: what does this text describe?`
}

/** 这一段流里有没有模型真的输出了内容（思考或正文）：只看增量事件，不把开头的空壳（role、message_start）算进去 */
export function hasContent(protocol: ApiProtocol, chunk: string) {
  if (protocol === 'anthropic') return /"type":"content_block_delta"/.test(chunk)
  if (protocol === 'openai-responses') return /"type":"response\.(output_text|reasoning[a-z_.]*)\.delta"/.test(chunk)
  return /"(content|reasoning_content|reasoning)":"[^"]/.test(chunk)
}
