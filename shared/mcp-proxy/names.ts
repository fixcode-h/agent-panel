/**
 * 经面板代理的外部工具在 Agent 那边的样子（ADR 0085）：不直接列进面板的工具表，收在 more_tools 后面，
 * 名字写成「服务/工具」（idea/lua_debug_session）。这样外部服务再多，面板服务的工具个数和定义长度也不涨（ADR 0067）。
 *
 * 这里放前后端共用的几样：名字的拼和拆、more_tools 说明里外部工具那一段、网关把 more_tools 的代理调用认成 mcp 调用
 */
import type { ToolCall } from '../tool-gateway/types.ts'

export const PROXY_SEP = '/'
export const proxyName = (server: string, tool: string) => `${server}${PROXY_SEP}${tool}`

/** 「服务/工具」拆开；「服务/」是列出这个服务的工具；不是这种写法返回 undefined */
export function splitProxyName(name: string): { server: string; tool: string } | undefined {
  const at = name.indexOf(PROXY_SEP)
  if (at <= 0) return undefined
  return { server: name.slice(0, at), tool: name.slice(at + 1) }
}

/** more_tools 说明里外部工具那一段最多多少字：定义整份每轮都带，服务多了只列服务名和个数（ADR 0067 的 3000 字上限） */
export const EXTERNAL_LIST_BUDGET = 1200

/** more_tools 说明里的一段：按服务列工具名；超出预算的服务只写个数，name 写「服务/」看全部 */
export function externalToolsText(tools: { server: string; tool: string }[], budget = EXTERNAL_LIST_BUDGET): string {
  if (!tools.length) return ''
  const by = new Map<string, string[]>()
  for (const x of tools) by.set(x.server, [...(by.get(x.server) ?? []), x.tool])
  const head = '经面板代理的外部服务工具（name 写「服务/工具」，例如 '
  const parts: string[] = []
  let used = 0
  for (const [server, names] of by) {
    const full = `${server}：${names.join('、')}`
    const short = `${server}：${names.length} 个（name 写「${server}/」列出）`
    const pick = used + full.length <= budget ? full : short
    parts.push(pick)
    used += pick.length
  }
  const [first] = tools
  return `${head}${proxyName(first.server, first.tool)}）：${parts.join('；')}。`
}

/**
 * 网关认调用（ADR 0084）：Agent 经 more_tools 调代理的外部工具时，这次调用算 mcp 调用（服务名、工具名、参数换成真正的），
 * 能力表按外部工具认（lua_code 归 find）；不是这种调用返回 undefined
 */
export function proxiedCallOf(call: ToolCall): ToolCall | undefined {
  if (call.kind !== 'panel' || call.panel !== 'more_tools') return undefined
  const name = typeof call.input.name === 'string' ? call.input.name.trim() : ''
  const sp = splitProxyName(name)
  if (!sp?.tool) return undefined
  const args = call.input.arguments
  const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const out: ToolCall = { ...call, kind: 'mcp', server: sp.server, mcpTool: sp.tool, input, proxied: true }
  delete out.panel
  return out
}

/** 对话里的 more_tools 那一行是不是代理调用：拆出服务、工具和参数，界面按外部工具显示；只查用法、不是代理调用返回 undefined */
export function unwrapProxied(
  input: string,
): { server: string; tool: string; args: Record<string, unknown> } | undefined {
  try {
    const v = JSON.parse(input)
    const sp = typeof v?.name === 'string' ? splitProxyName(v.name.trim()) : undefined
    if (!sp?.tool || !v.arguments || typeof v.arguments !== 'object') return undefined
    return { ...sp, args: v.arguments }
  } catch {
    return undefined
  }
}
