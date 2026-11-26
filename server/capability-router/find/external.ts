/**
 * 外部 MCP 服务上的查找路（插件登记的 ExternalFindSource，例如 VS 的 UEToVS、IDEA 的 lua_code）变成路由里的一条路：
 * 面板按工具名在能用的服务里找到它、自己当客户端去调。调用规矩（JetBrains 的 projectPath、仅路由器模式、等索引）
 * 和外部服务代理共用 server/mcp-client/call.ts 的同一份
 */
import type { ExternalFindSource, FindOutcome, FindRequest } from '../../../shared/capability-router/find/types.ts'
import { parseFindJson, relPath } from '../../../shared/capability-router/find/hits.ts'
import type { Readiness } from '../../../shared/capability-router/types.ts'
import { callExternalTool, errorOf, howToCall, type CallCtx } from '../../mcp-client/call.ts'
import type { RouteSource } from '../router.ts'
import type { RouteServer } from '../servers.ts'

export { routerCommand } from '../../mcp-client/call.ts'

export type FindCtx = CallCtx

/** 调一次（定不了项目、正在建索引由 callExternalTool 处理）；工具最后还是报错就抛出，路由按「这条路出错」往下走 */
async function callTool(
  sv: RouteServer,
  spec: ExternalFindSource,
  args: Record<string, unknown>,
  ctx: FindCtx,
  signal?: AbortSignal,
) {
  const r = await callExternalTool(sv, spec.tool, args, ctx, signal)
  if (!r.isError) return r.text
  const err = errorOf(r.text)
  throw new Error(err ? `${err.code}：${err.message}` : r.text.slice(0, 300) || '工具报错')
}

export function externalSource(
  spec: ExternalFindSource,
  servers: RouteServer[],
  ctx: FindCtx,
): RouteSource<FindRequest, FindOutcome> {
  const sv = servers.find((s) => howToCall(s, spec.tool) === 'direct') ?? servers.find((s) => howToCall(s, spec.tool))
  return {
    id: spec.id,
    // 卡片上写「服务 · 工具」（idea · lua_code）：用户认的是 IDE / VS 和工具名，不是插件登记的 id
    label: sv ? `${sv.name} · ${spec.tool}` : spec.tool,
    via: 'mcp',
    rank: spec.rank,
    accepts: (req) => spec.kinds.includes(req.kind) && spec.langs.includes(req.lang) && spec.args(req) !== null,
    ready: (): Readiness =>
      sv ? { state: 'ready' } : { state: 'down', why: `没有接 ${spec.tool} 所在的服务（没装，或服务没开）` },
    run: async (req, signal) => {
      const text = await callTool(sv!, spec, spec.args(req)!, ctx, signal)
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`返回的不是 JSON：${text.slice(0, 200)}`)
      }
      if (spec.parse) {
        // 插件自己读的结果：路径照样换成相对项目根（插件不知道这一轮的工作目录）
        const out = spec.parse(json, req)
        return { ...out, hits: out.hits.map((h) => ({ ...h, file: relPath(h.file, ctx.dirs) })) }
      }
      const out = parseFindJson(json, req, ctx.dirs)
      if (!out) throw new Error('返回的形状认不出来')
      return out
    },
  }
}

/** 这条路查到了算不算够（不用文本再补）：插件说了算，没说时 symbol / outline / members / include 够、refs 和 text 不够 */
export const externalFinal = (spec: ExternalFindSource, req: FindRequest) =>
  spec.final ?? (req.kind !== 'refs' && req.kind !== 'text')
