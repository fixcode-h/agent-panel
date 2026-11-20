import type { McpResult } from './sdk.ts'
import { clip } from '../../shared/text.ts'
import { saveHandoffFile } from '../exec/handoff-file.ts'

/**
 * 插件工具结果的上限（工作包 I）：插件工具的结果原样进 CLI 的会话，之后每次请求都作为历史带上，直到被压缩。
 * UE 插件导出资产、列蓝图节点时一次能回几万字，Claude Code 的 MCP 上限（25000 token）也挡不住多少。
 * 超过上限的文字存成文件，只回开头、结尾和文件路径，要细节时让模型自己去搜（和节点输出存文件留指针同一个做法）。
 * 存不了文件时整段交回：截断就必须写明全文在哪，不能悄悄丢掉一截
 */
export const PLUGIN_RESULT_CHARS = 12000
/** 截断时开头占的比例：结论、汇总一般在开头，结尾留给最后几行（报错常在最后） */
const HEAD_RATIO = 0.75

export type SaveFull = (name: string, text: string) => Promise<string>

/** 默认存到对话的交接目录（和子任务交回的完整结果放一起） */
export const saveToHandoff =
  (taskId: string): SaveFull =>
  (name, text) =>
    saveHandoffFile(taskId, { id: name, title: name }, text)

export async function clipPluginResult(
  res: McpResult,
  name: string,
  save: SaveFull,
  limit = PLUGIN_RESULT_CHARS,
): Promise<McpResult> {
  res = keepStructured(res)
  const texts = res.content.filter((c) => c.type === 'text')
  const all = texts.map((c) => c.text).join('\n\n')
  // 结构化结果会原样进模型的上下文（Claude Code 只看它），一样按上限算
  const size = Math.max(all.length, res.structuredContent ? JSON.stringify(res.structuredContent).length : 0)
  if (size <= limit) return res
  const { structuredContent: _s, ...plain } = res
  const file = await save(name, all).catch(() => '')
  // 存不了文件时整段文字交回（不悄悄截掉）；结构化结果是同一份内容，去掉免得进上下文两份
  if (!file) return res.structuredContent ? plain : res
  const mark = (n: number) => `\n\n…（中间省略 ${n} 字）…\n\n`
  const text = `${clip(all, limit, { tailRatio: HEAD_RATIO, mark })}\n\n（插件工具的完整结果有 ${all.length} 字，这里只附了开头和结尾。完整内容在文件 ${file}，要细节时用 rg 搜这个文件，不要整份读进来。）`
  // 图片原样保留，文字合成一段放在最前；截断后结构化结果对不上了，去掉（Claude Code 有它时只看它，截断的提示和路径就丢了）
  return { ...plain, content: [{ type: 'text', text }, ...res.content.filter((c) => c.type !== 'text')] }
}

/**
 * 结构化结果只在 content 恰好是一个 text 块时保留：Claude Code 有 structuredContent 时只把它交给模型，
 * 插件追加的提示文字、图片就悄悄丢了；宁可去掉它让模型看 content
 */
function keepStructured(res: McpResult): McpResult {
  if (!res.structuredContent) return res
  const ok =
    typeof res.structuredContent === 'object' &&
    !Array.isArray(res.structuredContent) &&
    res.content.length === 1 &&
    res.content[0].type === 'text'
  if (ok) return res
  const { structuredContent: _s, ...plain } = res
  return plain
}
