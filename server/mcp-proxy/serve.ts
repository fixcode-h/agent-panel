/**
 * 面板服务上的代理调用（ADR 0085）：Agent 经 more_tools 写「服务/工具」调外部工具，面板用连接池代调，
 * 调用规矩（JetBrains 的 projectPath、仅路由器模式、等索引）和能力路由的查找路共用 server/mcp-client/call.ts。
 *
 * - 只写 name 看用法：原样给出外部工具自己的说明和参数表；name 写「服务/」列出这个服务给 Agent 的工具；
 * - 被能力接管的工具（lua_code 这类）不执行，说明改用哪个面板工具；
 * - 工具自己报的错原样交回（外部工具的说明写着怎么办）；等索引等到期限还没好、连不上、断了时写清下一步。
 *   连不上、断了的服务记一笔（./state.ts），之后一段时间开跑时退回直接挂在 CLI 上；
 * - 每次调用在对话的工具卡片上挂「实际走的路」（ToolUse.route，via mcp），网关的调用记录由钩子那一侧记（kind mcp，见 shared/mcp-proxy/names.ts）
 */
import { performance } from 'node:perf_hooks'
import type { NoteToolRoute } from '../../shared/host/tool-route.ts'
import type { ToolRoute } from '../../shared/capability-router/tool-route.ts'
import { proxyName, splitProxyName } from '../../shared/mcp-proxy/names.ts'
import { callExternalTool, INDEX_WAIT_MS } from '../mcp-client/call.ts'
import { noteProxyFailure } from './state.ts'
import type { ProxySession } from './session.ts'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (s: string, isError = false): Result => ({
  content: [{ type: 'text', text: s }],
  ...(isError ? { isError } : {}),
})

/** 路由小标的那一条路：「idea · lua_debug_session」，via mcp */
export function proxyRoute(server: string, tool: string, ms: number, failed: string | undefined): ToolRoute {
  const hop = { source: `proxy:${server}`, label: `${server} · ${tool}`, via: 'mcp' as const }
  return {
    capability: 'mcp',
    served: failed ? [] : [hop],
    steps: [{ ...hop, outcome: failed ? 'failed' : 'used', ...(failed ? { why: failed } : {}), ms: Math.round(ms) }],
    ms: Math.round(ms),
  }
}

function listOf(s: ProxySession, server: string): Result {
  const sv = s.plan.servers.find((x) => x.name === server && x.mode === 'proxy')
  if (!sv) return text(`没有经面板代理的服务 ${server}。可用的：${proxiedServers(s).join('、') || '（没有）'}`, true)
  const lines = sv.tools.map((t) => {
    if (!t.shown) return `- ${t.name}：已由面板的 ${t.hiddenBy?.use} 接管，改用 ${t.hiddenBy?.use}`
    const d = s.defs
      .get(proxyName(server, t.name))
      ?.description?.split(/[。.\n]/)[0]
      ?.trim()
    return `- ${proxyName(server, t.name)}${d ? `：${d}` : ''}`
  })
  return text(`${server} 的工具（经 more_tools 调，先只写 name 看参数）：\n${lines.join('\n')}`)
}

const proxiedServers = (s: ProxySession) => s.plan.servers.filter((x) => x.mode === 'proxy').map((x) => x.name)

async function callProxied(
  s: ProxySession,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  noteRoute: NoteToolRoute | undefined,
): Promise<Result> {
  const sv = s.servers.get(server)!
  const t0 = performance.now()
  const done = (r: Result, failed?: string) => {
    noteRoute?.(proxyRoute(server, tool, performance.now() - t0, failed), proxyName(server, tool))
    return r
  }
  try {
    const r = await callExternalTool(sv, tool, args, { projectId: s.projectId, dirs: s.dirs }, signal)
    if (r.waitedIndex)
      return done(
        text(
          `${r.text}\n\n（面板等了 ${INDEX_WAIT_MS / 1000} 秒，${server} 的索引还没建好：过一会儿再调一次；要先找代码就用面板的 find，它会按文本兜底。）`,
          true,
        ),
        '索引还没建好',
      )
    return done(text(r.text, r.isError), r.isError ? r.text.slice(0, 120) : undefined)
  } catch (e) {
    const why = (e as Error).message
    noteProxyFailure(server, why)
    return done(
      text(
        `面板代为调用 ${server} 的 ${tool} 失败（${why}），这次没有执行。可以过一会儿再调一次；还是不行就告诉用户 ${server} 连不上，请他检查这个服务是否开着。下一轮起面板会把它直接挂给你。`,
        true,
      ),
      why,
    )
  }
}

/**
 * more_tools 这次调用是不是冲着外部工具来的：是就由代理回答，不是返回 undefined（交回面板原来的 more_tools）。
 * panelDeferred 是收起来的面板工具名：name 两边都对不上时一起列出来
 */
export function serveProxied(
  s: ProxySession | undefined,
  panelDeferred: string[],
  a: { name?: unknown; arguments?: unknown },
  signal?: AbortSignal,
  noteRoute?: NoteToolRoute,
): Promise<Result> | undefined {
  if (!s) return undefined
  const name = typeof a?.name === 'string' ? a.name.trim() : ''
  const sp = splitProxyName(name)
  if (!sp) {
    if (panelDeferred.includes(name)) return undefined
    const all = [...panelDeferred, ...proxiedServers(s).map((x) => `${x}/`)]
    return Promise.resolve(text(`没有这个工具：${name || '（没写 name）'}。可用的：${all.join('、')}`, true))
  }
  if (!sp.tool) return Promise.resolve(listOf(s, sp.server))
  const plan = s.plan.servers.find((x) => x.name === sp.server)
  const entry = plan?.tools.find((x) => x.name === sp.tool)
  if (entry && !entry.shown)
    return Promise.resolve(
      text(
        `${sp.tool} 已由面板的 ${entry.hiddenBy?.use} 接管，不再单独给：改用面板工具 ${entry.hiddenBy?.use}（面板会按语言和索引状态挑 ${sp.server} 或别的路）。`,
        true,
      ),
    )
  const def = s.defs.get(name)
  if (!def || plan?.mode !== 'proxy') return Promise.resolve(listOf(s, sp.server))
  if (a.arguments === undefined || a.arguments === null)
    return Promise.resolve(
      text(
        `${name}：${def.description ?? ''}\n参数（JSON Schema）：${JSON.stringify(def.inputSchema ?? {})}\n调用：more_tools，name 写 ${name}，arguments 按上面的参数写。`,
      ),
    )
  const args =
    typeof a.arguments === 'object' && !Array.isArray(a.arguments) ? (a.arguments as Record<string, unknown>) : {}
  return callProxied(s, sp.server, sp.tool, args, signal, noteRoute)
}
