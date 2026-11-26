/**
 * 按一次 CLI 调用开网关：dispatch.ts 只调这一个函数，项目事实（自建工具、已知的外部 MCP 服务）在这里接好。
 * 网关模式存在 hooks.json（HooksData.gateway），和内置钩子的设置同一份
 */
import type { HooksData } from '../../shared/hooks/defs.ts'
import { getCli } from '../../shared/clis.ts'
import { customToolSigs } from '../../shared/custom-tools/match.ts'
import { resolveMcpTool } from '../../shared/mcp-catalog/tool-params.ts'
import { listTools } from '../custom-tools/store.ts'
import { knownExternalServers } from '../mcp-catalog/external-titles.ts'
import { openGateway, type Gateway } from './gateway.ts'

export function gatewayForCall(
  c: { task: { id: string; title: string }; project: { id?: string }; cliId: string },
  data: HooksData,
): Gateway | undefined {
  const projectId = c.project.id ?? ''
  return openGateway({
    mode: data.gateway.mode,
    task: { id: c.task.id, title: c.task.title },
    projectId,
    cliId: c.cliId,
    spec: getCli(c.cliId)?.hooks,
    claimCtx: async () => ({
      customTools: customToolSigs((await listTools(projectId || undefined).catch(() => undefined))?.entries ?? []),
    }),
    resolveMcp: async (name, input) => resolveMcpTool(name, input, await knownExternalServers()),
  })
}
