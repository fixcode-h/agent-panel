/**
 * 面板接管工具调用时 CLI 能做到哪一步（设计稿「技能与自建工具按情境加载」5.3，写进 CLI 定义的 takeover，代码按字段走、不按 CLI 名字分支）。
 * 这里登记外部服务代理（ADR 0085）要的 mcpOnlyPanel；改写、代答这些字段由工具网关第二期另外加在同一个对象上
 */
import { z } from 'zod'

export const CliTakeover = z.object({
  /**
   * 只用面板给的 MCP 服务的启动参数（Claude Code 的 --strict-mcp-config）：加上后 CLI 不再读项目和全局配置里的服务，
   * 外部服务改由面板代理（server/mcp-proxy/）；代理不了的由面板按 mcpStore.inject 逐个带上。不写表示这个 CLI 做不到，外部服务照旧直接挂
   */
  mcpOnlyPanel: z.array(z.string()).optional(),
})
export type CliTakeover = z.infer<typeof CliTakeover>
