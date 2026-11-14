/**
 * 引擎宿主里和「怎么找代码」有关的部分：搜索排除、是不是 Git 仓库、项目能用的代码索引 MCP 工具。
 * 都只用来拼提示词里「搜索（这个项目）」那一节（shared/engine/prompt-parts.ts 的 searchPart）。
 */
import type { CodeIndexTool } from '../mcp-catalog/code-index.ts'

export interface SearchHost {
  /**
   * 项目设置里的搜索排除目录（项目自己填的会补上内置默认，见 search-exclude.ts）：
   * 写进搜索那一段，Agent 直接照着拼 `-g '!目录'`，不靠临场叮嘱
   */
  searchExclude?: string[]
  /**
   * 工作目录是 Git 仓库：rg / git grep / CLI 自带的搜索本来就跳过 .gitignore 里的产物，
   * 搜索段只需补项目自己填的目录，并提醒别加 --no-ignore 把它们又扫回来
   */
  searchInGit?: boolean
  /**
   * 这个项目能用的代码索引 MCP 工具（server/mcp-catalog/code-index.ts 认出或项目设置里指定的）：
   * 写进搜索那一节的第一步，Agent 先按符号查、查不到才 rg；不传时那一步只给通用提醒
   */
  codeIndexTools?: CodeIndexTool[]
}
