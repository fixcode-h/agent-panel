import { z } from 'zod'
import { getLang } from '../i18n.ts'
import { knownToolTitle } from './known-titles.ts'

/**
 * 别家 MCP 服务（不是面板、也不是插件的服务，例如 UEToVS）给自己工具起的显示名。
 * 对话里的工具行原来只能露英文原名（search_symbols），面板替它们起不了名，所以让服务自己在 tools/list 里报：
 * - 标准的 `title`（MCP 2025-06-18 起有，旧服务写在 `annotations.title`）：一般是英文；
 * - `_meta.titles`：按语言给的显示名，例如 `{ "zh": "搜索 C++ 符号", "en": "Search C++ symbols" }`。
 * 面板按自己的界面语言挑：先挑同语言的，再退回 title，都没有就用原名。
 * 服务端在 Agent 第一次用到某个服务时连上去问一遍并缓存（server/mcp-catalog/external-titles.ts），经页面事件推给网页。
 */
export const McpToolTitle = z.object({
  /** tools/list 的 title（没有时取 annotations.title） */
  title: z.string().optional(),
  /** _meta.titles：语言 → 显示名，语言写 zh / en（zh-CN 这类按前两个字母认） */
  titles: z.record(z.string(), z.string()).optional(),
})
export type McpToolTitle = z.infer<typeof McpToolTitle>

/** 服务名 → 工具名 → 显示名 */
export const McpToolTitles = z.record(z.string(), z.record(z.string(), McpToolTitle))
export type McpToolTitles = z.infer<typeof McpToolTitles>

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

// IDE 自带的 MCP 服务（JetBrains 系）不转发插件写的 _meta，EmmyLua 这类插件只好把中文名写在说明的最后一行：
// 「Title (zh): Lua 调试：会话与单步」（fixcode-h/IntelliJ-EmmyLua 的约定）。有多行时取最后一个
const ZH_TITLE_LINE = /^[ \t]*Title \(zh\):[ \t]*(.+?)[ \t]*$/gm

/** 从说明里拆出「Title (zh): …」那一行：返回去掉这一行的说明和中文名；没有这一行原样返回 */
export function splitZhTitleLine(description: string): { description: string; zh?: string } {
  const all = [...description.matchAll(ZH_TITLE_LINE)]
  const last = all.at(-1)
  if (!last || last.index === undefined) return { description }
  const rest = (description.slice(0, last.index) + description.slice(last.index + last[0].length)).replace(/\s+$/, '')
  return { description: rest, zh: last[1] }
}

/** 从 tools/list 的一个工具里取显示名；什么都没报返回 undefined */
export function titleOfTool(x: any): McpToolTitle | undefined {
  const title = str(x?.title) ?? str(x?.annotations?.title)
  const raw = x?._meta?.titles
  const titles: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    for (const [k, v] of Object.entries(raw)) {
      const s = str(v)
      if (s) titles[k.slice(0, 2).toLowerCase()] = s
    }
  // _meta 里没报中文名时认说明最后一行的「Title (zh): …」
  const zh = typeof x?.description === 'string' ? splitZhTitleLine(x.description).zh : undefined
  if (zh && !titles.zh) titles.zh = zh
  const has = Object.keys(titles).length > 0
  if (!title && !has) return undefined
  return { ...(title && { title }), ...(has && { titles }) }
}

let known: McpToolTitles = {} // 模块状态：缓存副本，服务端读缓存文件、网页收推送时整份换掉

export function setMcpToolTitles(next: McpToolTitles) {
  known = next
}

export const mcpToolTitles = () => known

/** 别家服务的工具在当前界面语言下的显示名；服务没报就返回空，调用方用原名 */
export function externalToolTitle(server: string, tool: string): string {
  const e = known[server]?.[tool] ?? known[server.toLowerCase()]?.[tool]
  const lang = getLang()
  // 服务报的同语言名优先；没报就用面板备好的（JetBrains IDE 这类只报英文的服务，见 known-titles.ts）；
  // 再退回服务给的 title：中文界面至少显示服务给的英文显示名，比原名好认
  return e?.titles?.[lang] ?? knownToolTitle(server, tool)?.titles?.[lang] ?? e?.title ?? ''
}
