/**
 * 面板工具交给 CLI 前补上声明里的使用时机（设计稿：MCP能力菜单 5.1）。
 * 单独一个文件：ask-mcp.ts 要用它，目录（./panel.ts）又要读 ask-mcp.ts 的提问工具，放一起会互相引用
 */
import { describeTool } from '../../shared/mcp-catalog/describe.ts'
import { PANEL_TOOL_GUIDE } from '../../shared/mcp-catalog/panel-guides.ts'
import type { PanelToolName } from '../../shared/panel-tools.ts'

export const panelGuide = (name: string) =>
  PANEL_TOOL_GUIDE[name as PanelToolName] as (typeof PANEL_TOOL_GUIDE)[PanelToolName] | undefined

/** 工具清单里的每一项：说明后面补「什么时候用 / 不要用」，其余字段原样 */
export function withPanelGuides<T extends { name: string; description: string }>(list: T[]): T[] {
  return list.map((t) => {
    const g = panelGuide(t.name)
    return g ? { ...t, description: describeTool(t.description, g) } : t
  })
}
