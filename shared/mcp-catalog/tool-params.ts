/**
 * 别家 MCP 工具的真实参数表（A2，设计稿 designs/Agent写代码能力-提升与扩展分析.md）。
 *
 * 为什么要存：#398 的起因是提示词里手写了「传 projectPath」，Agent 照着给 IDE 里的 lua_code 也传了，被当成未知参数整次失败；
 * 修法又是再手写一段参数规矩。别家工具的参数名写死在提示词里，工具一改就过期，模型还会照抄到别的工具上。
 * 所以面板探测服务时（server/mcp-catalog/external-titles.ts）把每个工具的参数名、必填、取值存下来，
 * 提示词里的参数规矩（code-index.ts 的 ideMcpLines）和「参数传错」的工具后提醒（server/hooks/tool-after-hints.ts）都从这张表来。
 */
import type { CatalogParam } from './types.ts'

/** 一个参数：名字、类型（有枚举时是「a | b」），必填才带 required */
export interface ParamBrief {
  name: string
  type: string
  required?: true
}

/** 一个工具存多少字的参数表：说明不存，只存名字、类型和必填，够模型照着改参数 */
export const PARAMS_MAX = 300

/** 写进缓存的参数表：按 PARAMS_MAX 截，先截长枚举、再丢可选参数，必填的一个不丢 */
export function briefParams(params: CatalogParam[]): ParamBrief[] {
  const all: ParamBrief[] = params.map((p) => ({ name: p.name, type: p.type, ...(p.required && { required: true }) }))
  const size = (xs: ParamBrief[]) => JSON.stringify(xs).length
  if (size(all) <= PARAMS_MAX) return all
  const short = all.map((p) => (p.type.length > 60 ? { ...p, type: `${p.type.slice(0, 59)}…` } : p))
  // 必填的排前面，超了从后往前丢可选的
  const kept = [...short.filter((p) => p.required), ...short.filter((p) => !p.required)]
  while (kept.length > 1 && size(kept) > PARAMS_MAX && !kept[kept.length - 1].required) kept.pop()
  return kept
}

/** 读缓存时核对形状：旧缓存、手改坏的项丢掉 */
export function parseParams(raw: unknown): ParamBrief[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ParamBrief[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const { name, type, required } = x as Record<string, unknown>
    if (typeof name !== 'string' || !name) continue
    out.push({ name, type: typeof type === 'string' ? type : 'any', ...(required === true && { required: true }) })
  }
  return out
}

/** 写给模型看的一行参数表：「action（必填）：search | files、query：string」；没有参数写「不带参数」 */
export function paramTableText(params: ParamBrief[]): string {
  if (!params.length) return '不带参数'
  return params.map((p) => `${p.name}${p.required ? '（必填）' : ''}：${p.type}`).join('、')
}

export const hasParam = (params: ParamBrief[] | undefined, name: string) => !!params?.some((p) => p.name === name)

/** 缓存里一个服务的工具表（resolveMcpTool 只要名字） */
export interface KnownServer {
  server: string
  names: string[]
}

/**
 * CLI 报上来的工具名对应缓存里哪个服务的哪个工具。各家写法不一样（mcp__idea__lua_code、idea_lua_code、Pi 的裸名字），
 * 不按 CLI 写分支：完整名字以工具名结尾、前面带着服务名（或者就是裸工具名、只有一个服务有它）就算对上，几个都对上取工具名最长的。
 * 经「仅路由器」的 execute_tool 转调时，真正的工具是 command 的第一个词
 */
export function resolveMcpTool(
  name: string,
  input: Record<string, unknown>,
  servers: KnownServer[],
): { server: string; tool: string } | undefined {
  const hits: { server: string; tool: string }[] = []
  for (const s of servers)
    for (const tool of s.names) {
      if (name === tool) hits.push({ server: s.server, tool })
      else if (name.endsWith(tool) && /[\W_]$/.test(name.slice(0, -tool.length)) && name.includes(s.server))
        hits.push({ server: s.server, tool })
    }
  // 裸名字在几个服务里都有时认不出是哪个，不猜
  const bare = hits.filter((h) => h.tool === name)
  const pick = bare.length > 1 && bare.length === hits.length ? [] : hits
  const best = pick.sort((a, b) => b.tool.length - a.tool.length)[0]
  if (!best || best.tool !== 'execute_tool') return best
  const cmd = typeof input.command === 'string' ? input.command.trim().split(/\s+/)[0] : ''
  const routed = servers.find((s) => s.server === best.server)?.names.includes(cmd)
  return routed ? { server: best.server, tool: cmd } : best
}
