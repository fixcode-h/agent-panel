/**
 * 面板服务上的代理会话（ADR 0085）：开跑时由 ./launch.ts 算好、挂到面板服务（server/ask-mcp.ts）上，more_tools 按它列外部工具、转调用（./serve.ts）。
 * 单独放一个文件：面板服务只认这个形状，不把开跑时才用的配置读取、插件查询这些模块带进来
 */
import { shownProxied } from '../../shared/mcp-proxy/exposure.ts'
import type { ExposurePlan } from '../../shared/mcp-proxy/types.ts'
import type { CallableServer } from '../mcp-client/call.ts'
import type { McpToolDef } from '../mcp-client/pool.ts'

export interface ProxySession {
  plan: ExposurePlan
  /** 「服务/工具」→ 工具定义（看用法时原样给 Agent） */
  defs: Map<string, McpToolDef>
  servers: Map<string, CallableServer>
  projectId: string
  dirs: string[]
}

/** 给 Agent 的外部工具（more_tools 的说明里列的） */
export const proxiedTools = (s: ProxySession) => shownProxied(s.plan)
