/**
 * 按一次 CLI 调用开网关：dispatch.ts 只调这一个函数，项目事实（自建工具、已知的外部 MCP 服务）在这里接好。
 * 网关模式存在 hooks.json（HooksData.gateway），和内置钩子的设置同一份。
 * 改道模式的查找接管（ADR 0084 第二期）要的也在这里接：CLI 定义的 takeover、钩子有没有改写模板、这一轮的 find
 */
import type { HooksData } from '../../shared/hooks/defs.ts'
import { getCli } from '../../shared/clis.ts'
import { customToolSigs } from '../../shared/custom-tools/match.ts'
import { resolveMcpTool } from '../../shared/mcp-catalog/tool-params.ts'
import type { OrchFindCode } from '../../shared/host/find-code.ts'
import type { OrchToolRoute } from '../../shared/host/tool-route.ts'
import { DEFAULT_TAKEOVER } from '../../shared/tool-gateway/takeover-spec.ts'
import { listTools } from '../custom-tools/store.ts'
import { knownExternalServers } from '../mcp-catalog/external-titles.ts'
import { openGateway, type Gateway } from './gateway.ts'

export function gatewayForCall(
  c: {
    task: { id: string; title: string }
    project: { id?: string }
    cliId: string
    /** CLI 的工作目录：接管时命令里的相对路径按它算 */
    cwd?: string
    call?: { orch?: OrchFindCode & OrchToolRoute }
  },
  data: HooksData,
): Gateway | undefined {
  const projectId = c.project.id ?? ''
  const cli = getCli(c.cliId)
  return openGateway({
    mode: data.gateway.mode,
    task: { id: c.task.id, title: c.task.title },
    projectId,
    cliId: c.cliId,
    spec: cli?.hooks,
    claimCtx: async () => ({
      customTools: customToolSigs((await listTools(projectId || undefined).catch(() => undefined))?.entries ?? []),
    }),
    resolveMcp: async (name, input) => resolveMcpTool(name, input, await knownExternalServers()),
    takeover: c.cwd
      ? {
          takeover: cli?.takeover ?? DEFAULT_TAKEOVER,
          rewriteTpl: cli?.hooks?.events['tool.before']?.rewrite !== undefined,
          cwd: c.cwd,
          findCode: c.call?.orch?.findCode,
          noteRoute: c.call?.orch?.noteRoute,
        }
      : undefined,
  })
}
