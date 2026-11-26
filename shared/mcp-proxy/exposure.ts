/**
 * ExposurePolicy（ADR 0085，设计稿「技能与自建工具按情境加载」6.3）：开跑时决定给 Agent 哪些工具。
 *
 * - 外部服务能代理的经面板代理（CLI 只挂面板一个服务），代理不了的（连不上、协议不支持、最近代理出过错）退回直接挂在 CLI 上，
 *   Agent 不少工具；
 * - 代理的服务里，被能力接管的工具（lua_code、search_symbols 这类查找工具）不给 Agent，改用面板的入口工具（find）。
 *   这一轮没给那个入口工具时（例如只有四个工具的 Chat 对话没有 find）不接管，照样给；
 * - 直接挂的服务面板管不了单个工具，照样全给（调用照旧经钩子进网关，只记录）。
 *
 * 接管登记是一张表（ExternalClaim）：自带的一行是 find 接管外部查找工具，插件登记的查找路（ExternalFindSource）用到的工具也自动算 find 接管的；
 * 以后改动生效（apply）接管 Live Coding 那几个工具时也只加一行。纯函数，服务端和演示后端用同一份
 */
import { EXTERNAL_FIND_TOOLS } from '../capability-router/capabilities.ts'
import type { CapabilityId } from '../capability-router/types.ts'
import type { ExposedTool, ExposurePlan, ExposureWhy, ServerExposure } from './types.ts'

export interface ExternalClaim {
  capability: CapabilityId
  /** 接管后 Agent 改用的面板工具 */
  use: string
  tools: readonly string[]
  /** 谁登记的：builtin，或插件 id */
  by: string
}

/** 自带的接管登记 */
export const BUILTIN_CLAIMS: readonly ExternalClaim[] = [
  { capability: 'find', use: 'find', tools: EXTERNAL_FIND_TOOLS, by: 'builtin' },
]

/** 自带的 + 插件的（插件登记的查找路用到的工具算 find 接管；同一个工具登记两次只留第一次） */
export function externalClaims(findSources: { tool: string; by: string }[] = []): ExternalClaim[] {
  const seen = new Set(BUILTIN_CLAIMS.flatMap((c) => c.tools))
  const extra = new Map<string, string[]>()
  for (const s of findSources) {
    if (seen.has(s.tool)) continue
    seen.add(s.tool)
    extra.set(s.by, [...(extra.get(s.by) ?? []), s.tool])
  }
  return [
    ...BUILTIN_CLAIMS,
    ...[...extra].map(([by, tools]) => ({ capability: 'find' as const, use: 'find', tools, by })),
  ]
}

/** 一个外部服务开跑前问到的事实 */
export interface ServerFacts {
  name: string
  source: string
  /** ok：问到了工具表；其余是退回直接挂的原因 */
  state: 'ok' | Extract<ExposureWhy, 'unreachable' | 'protocol' | 'failed'>
  detail?: string
  tools: string[]
}

export interface ExposureInput {
  /** 设置里的代理开关（默认开） */
  enabled: boolean
  /** CLI 能只挂面板（takeover.mcpOnlyPanel），也能把退回的服务按轮带上（mcpStore.inject） */
  cliCan: boolean
  /** 这一轮挂着面板的工具服务 */
  panel: boolean
  /** 这一轮面板给了的工具：接管后改用的那个不在时不接管 */
  panelTools: readonly string[]
  servers: ServerFacts[]
  claims: readonly ExternalClaim[]
}

/** 这个工具在这一轮被谁接管（没给接管后的入口工具时不算） */
export function claimOf(tool: string, claims: readonly ExternalClaim[], panelTools: readonly string[]) {
  return claims.find((c) => c.tools.includes(tool) && panelTools.includes(c.use))
}

function toolsOf(s: ServerFacts, i: ExposureInput, proxied: boolean): ExposedTool[] {
  return s.tools.map((name) => {
    const c = proxied ? claimOf(name, i.claims, i.panelTools) : undefined
    return c
      ? { name, shown: false, hiddenBy: { capability: c.capability, use: c.use, by: c.by } }
      : { name, shown: true }
  })
}

export function exposurePlan(i: ExposureInput): ExposurePlan {
  const whole: ExposureWhy | undefined = !i.enabled ? 'off' : !i.cliCan ? 'cli' : !i.panel ? 'no-panel' : undefined
  const servers: ServerExposure[] = i.servers.map((s) => {
    const why: ExposureWhy = whole ?? (s.state === 'ok' ? 'proxied' : s.state)
    const proxied = why === 'proxied'
    return {
      name: s.name,
      source: s.source,
      mode: proxied ? 'proxy' : 'direct',
      why,
      // 原话只跟着它自己的原因走：整轮因为关了代理、CLI 做不到而直接挂时，连没连上不相干
      ...(s.detail && why === s.state ? { detail: s.detail } : {}),
      tools: toolsOf(s, i, proxied),
    }
  })
  return { proxy: servers.some((s) => s.mode === 'proxy'), servers }
}

/** 一轮里经代理、给 Agent 的工具（服务名 + 工具名） */
export const shownProxied = (plan: ExposurePlan) =>
  plan.servers
    .filter((s) => s.mode === 'proxy')
    .flatMap((s) => s.tools.filter((x) => x.shown).map((x) => ({ server: s.name, tool: x.name })))
