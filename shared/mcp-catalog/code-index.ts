/**
 * 代码索引类的 MCP 工具（UEToVS 的 search_lua、search_symbols 这类）：按符号找函数、类、GM 命令，比 rg 扫目录快得多也准得多。
 *
 * 为什么面板要专门认它们：Agent 拿到的搜索规则原来只教 rg，别家服务的工具又是 CLI 自己从 .mcp.json 装的，
 * 提示词里从来不出现这些工具名；Claude Code 工具一多还会把 MCP 工具延迟加载，Agent 只看得到名字、看不到说明，
 * 结果一律先 grep 整个目录（用户 2026-11-14 报：查 GM 为什么无效时先 grep 失败一次，追问后用 search_lua 一下定位）。
 * 所以面板认出项目里的这类工具，把服务名、工具名和一句说明直接写进提示词的「搜索（这个项目）」一节。
 */

/** 一个代码索引工具：服务名 + 工具名，desc 是工具说明的第一句（看得出管哪种语言） */
export interface CodeIndexTool {
  server: string
  tool: string
  desc?: string
}

// 名字里带「搜 / 找」和「符号 / 代码 / 定义 / 引用」这类词的才算：search_files 这种按文件名找的也算（比 find 快），
// 写东西、跑东西的工具（build、edit、run）一律不算
const SEARCH_WORD = /(search|find|lookup|locate|grep|query|goto|go_to)/i
const INDEX_WORD =
  /(symbol|lua|code|class|function|func|method|def|definition|reference|refs?\b|usage|caller|callee|text|file|source|type|struct|enum|cpp|blueprint)/i
const WRITE_WORD = /(write|edit|create|delete|remove|rename|build|compile|run|exec|set_|update)/i
// 名字就是 definition / references / symbols 这类（LSP 风格）的也算
const LSP_NAME = /^(get_?)?(symbols?|definitions?|references?|find_references|workspace_symbols?|document_symbols?)$/i

export function isCodeIndexTool(name: string): boolean {
  if (WRITE_WORD.test(name)) return false
  if (LSP_NAME.test(name)) return true
  return SEARCH_WORD.test(name) && INDEX_WORD.test(name)
}

/** 工具说明的第一句，最多 100 字：提示词里一行一个工具，够看出语言和用途就行 */
export function briefDesc(description: string | undefined): string | undefined {
  const s = (description ?? '')
    .trim()
    .split(/(?<=[。.！？!?])\s|\n/)[0]
    ?.trim()
  if (!s) return undefined
  return s.length > 100 ? `${s.slice(0, 99)}…` : s
}

/**
 * 项目设置里手动指定的一项：写成「服务名/工具名」（例如 uetovs/search_lua），格式不对的丢掉
 */
export function parseCodeIndexItem(item: string): Pick<CodeIndexTool, 'server' | 'tool'> | undefined {
  const m = item.trim().match(/^([^/\s]+)\/([^/\s]+)$/)
  return m ? { server: m[1], tool: m[2] } : undefined
}

/** 「搜索（这个项目）」一节的第一步：有认出的工具就逐个列出，没认出也提醒「工具列表里有就先用」 */
export function codeIndexLines(tools: CodeIndexTool[] | undefined): string[] {
  const head =
    '1. 先用代码索引 MCP 工具：按函数名、类名、变量名、GM 命令、报错里的标识符找代码时，先用它查到文件和行号，再直接读那一处；它没命中、不覆盖这种语言，或者要搜的是任意文本（日志原文、注释）时，才往下用 rg。'
  if (!tools?.length)
    return [
      head,
      '   这个项目没认出代码索引工具；工具列表里有名字像 `search_symbols`、`search_lua`、`find_references` 的 MCP 工具时照样先用（只看得到名字、看不到说明的，先加载它的说明再判断）。',
    ]
  return [
    head,
    '   这个项目接了这些（只看得到名字、看不到说明的，先加载它的说明再用，不要因此改用 rg）：',
    ...tools.map((t) => `   - ${t.server} 服务的 \`${t.tool}\`${t.desc ? `：${t.desc}` : ''}`),
  ]
}
