/**
 * 设置 →「MCP」的接口契约（写法见 ./define.ts）：面板和开着的插件给 Agent 的 MCP 能力目录、自检。
 */
import { endpoint } from './define.ts'
import { McpCatalog, McpCheckInput, McpCheckResult } from '../mcp-catalog/types.ts'

export const mcpCatalogContract = {
  /** 能力目录：面板自带的服务和动作、开着的插件 */
  catalog: endpoint({ method: 'GET', path: '/mcp-catalog', res: McpCatalog }),
  /** 自检：按真实规则现算这样一轮对话能拿到什么，不开对话、不起 CLI */
  check: endpoint({ method: 'POST', path: '/mcp-catalog/check', body: McpCheckInput, res: McpCheckResult }),
}
