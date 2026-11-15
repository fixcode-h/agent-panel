import type { CatalogSource, CatalogTool } from './types.ts'

/**
 * 工具说明大约占多少 tokens（项目「能力」页的「交给 Agent 的」小结用）：只求个量级，看得出关掉一个插件能省多少。
 * 按经验估：英文、符号大约 4 个字符一个 token，中文大约一个字 0.7 个 token；名称、说明和参数表都算进去
 */
export function estimateTokens(text: string) {
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else wide++
  }
  return Math.ceil(ascii / 4 + wide * 0.7)
}

const toolText = (x: CatalogTool) =>
  [x.name, x.description, ...x.params.map((p) => `${p.name} ${p.type} ${p.description}`)].join('\n')

/** 一个来源直接交给 Agent 的工具数和说明 tokens；收进 more_tools 的不直接列出，不算 */
export function sourceCost(src: Pick<CatalogSource, 'servers'>) {
  let tools = 0
  let tokens = 0
  for (const s of src.servers)
    for (const x of s.tools) {
      if (x.deferred) continue
      tools++
      tokens += estimateTokens(toolText(x))
    }
  return { tools, tokens }
}
