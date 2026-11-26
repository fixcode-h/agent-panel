/**
 * 按一次 CLI 调用开网关：dispatch.ts 只调这一个函数，项目事实（自建工具、已知的外部 MCP 服务、这一轮挂没挂 request_build）在这里接好。
 * 网关模式存在 hooks.json（HooksData.gateway），和内置钩子的设置同一份。
 * 改道模式的查找接管（ADR 0084 第二期）要的也在这里接：CLI 定义的 takeover、钩子有没有改写模板、这一轮的 find
 */
import type { HooksData } from '../../shared/hooks/defs.ts'
import { getCli } from '../../shared/clis.ts'
import { customToolSigs } from '../../shared/custom-tools/match.ts'
import type { ToolEntry } from '../../shared/custom-tools/schema.ts'
import { usable } from '../../shared/custom-tools/text.ts'
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
    /** 这次调用的工作目录（独立分支里是分支目录）：改过的文件、接管时命令里的相对路径都按它算，校验工具在它下面跑 */
    cwd: string
    call: { orch?: OrchFindCode & OrchToolRoute & { ueBuild?: '' | 'child' | 'parent' } }
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
  const cli = getCli(c.cliId)
  return openGateway({
    mode: data.gateway.mode,
    task: { id: c.task.id, title: c.task.title },
    projectId,
    cliId: c.cliId,
    spec: cli?.hooks,
    claimCtx: async () => ({ customTools: customToolSigs(await tools()), build: c.call.orch?.ueBuild ?? '' }),
    resolveMcp: async (name, input) => resolveMcpTool(name, input, await knownExternalServers()),
    verify: {
      where: { projectId: projectId || undefined, root: c.cwd },
      tools: async () => usable(await tools()).map((e) => ({ tool: e.tool!, scope: e.scope })),
    },
    takeover: c.cwd
      ? {
          takeover: cli?.takeover ?? DEFAULT_TAKEOVER,
          rewriteTpl: cli?.hooks?.events['tool.before']?.rewrite !== undefined,
          cwd: c.cwd,
          findCode: c.call.orch?.findCode,
          noteRoute: c.call.orch?.noteRoute,
        }
      : undefined,
  })
}
