/**
 * 外部 MCP 服务代理（ADR 0085）的接口契约：设置「Agent 工具 → 工具路由」的「给 Agent 的工具」和代理开关。
 * 服务端 server/mcp-proxy/api.ts，演示 web/src/lib/demo/demo-mcp-proxy.ts；视图都由 shared/mcp-proxy/view.ts 拼
 */
import { z } from 'zod'
import { endpoint } from './define.ts'
import { ExposureRun, ExternalClaimView } from '../mcp-proxy/types.ts'

export const ExposureView = z.object({
  /** 设置里的代理开关（默认开） */
  enabled: z.boolean(),
  /** 各 CLI 能不能只挂面板（CLI 定义 takeover.mcpOnlyPanel） */
  clis: z.array(z.object({ id: z.string(), name: z.string(), mcpOnlyPanel: z.boolean() })),
  /** 被能力接管、不再给 Agent 的外部工具（自带的和插件登记的） */
  claims: z.array(ExternalClaimView),
  /** 每个 CLI 最近一次开跑时算出来的，新的在前 */
  runs: z.array(ExposureRun),
})
export type ExposureView = z.infer<typeof ExposureView>

export const mcpProxyContract = {
  /** 查询参数 projectId：只看这个项目的开跑记录、加上这个项目打开的插件登记的接管 */
  exposure: endpoint({ method: 'GET', path: '/mcp-proxy/exposure', res: ExposureView }),
  setSettings: endpoint({
    method: 'PUT',
    path: '/mcp-proxy/settings',
    body: z.object({ enabled: z.boolean() }),
    res: z.object({ enabled: z.boolean() }),
  }),
}
