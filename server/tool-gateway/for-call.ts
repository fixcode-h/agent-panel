/**
 * 按一次 CLI 调用开网关：dispatch.ts 只调这一个函数，项目事实（自建工具、已知的外部 MCP 服务、这一轮挂没挂 request_build）在这里接好。
 * 网关模式存在 hooks.json（HooksData.gateway），和内置钩子的设置同一份
 */
import type { HooksData } from '../../shared/hooks/defs.ts'
import { getCli } from '../../shared/clis.ts'
import { customToolSigs } from '../../shared/custom-tools/match.ts'
import type { ToolEntry } from '../../shared/custom-tools/schema.ts'
import { usable } from '../../shared/custom-tools/text.ts'
import { resolveMcpTool } from '../../shared/mcp-catalog/tool-params.ts'
import { listTools } from '../custom-tools/store.ts'
import { knownExternalServers } from '../mcp-catalog/external-titles.ts'
import { openGateway, type Gateway } from './gateway.ts'

export function gatewayForCall(
  c: {
    task: { id: string; title: string }
    project: { id?: string }
    cliId: string
    /** 这次调用的工作目录（独立分支里是分支目录）：改过的文件按它算、校验工具在它下面跑 */
    cwd: string
    call: { orch?: { ueBuild?: '' | 'child' | 'parent' } }
  },
  data: HooksData,
): Gateway | undefined {
  const projectId = c.project.id ?? ''
  // 自建工具表一轮只读一次：推算改道、改完校验都用这一份
  let entries: Promise<ToolEntry[]> | undefined
  const tools = () =>
    (entries ??= listTools(projectId || undefined)
      .then((r) => r.entries)
      .catch(() => []))
  return openGateway({
    mode: data.gateway.mode,
    task: { id: c.task.id, title: c.task.title },
    projectId,
    cliId: c.cliId,
    spec: getCli(c.cliId)?.hooks,
    claimCtx: async () => ({ customTools: customToolSigs(await tools()), build: c.call.orch?.ueBuild ?? '' }),
    resolveMcp: async (name, input) => resolveMcpTool(name, input, await knownExternalServers()),
    verify: {
      where: { projectId: projectId || undefined, root: c.cwd },
      tools: async () => usable(await tools()).map((e) => ({ tool: e.tool!, scope: e.scope })),
    },
  })
}
