/**
 * 引擎宿主里和「项目接的 JetBrains IDE MCP 服务」有关的部分：只用来在提示词「搜索（这个项目）」一节补上调它的规矩
 * （shared/mcp-catalog/code-index.ts 的 ideMcpLines）。和 SearchHost 分开放：那个接口已经满了（结构检查的成员上限）。
 */
import type { IdeMcpServer } from '../mcp-catalog/code-index.ts'

export interface IdeMcpHost {
  /** 项目接的 JetBrains IDE MCP 服务（server/mcp-catalog/code-index.ts 的 ideMcpServersFor 认出） */
  ideMcpServers?: IdeMcpServer[]
}
