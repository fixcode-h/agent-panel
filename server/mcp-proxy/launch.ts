/**
 * McpProxy 开跑这一步（ADR 0085）：一次 CLI 调用之前算好这一轮的外部服务怎么给——
 * 1. 收这一轮 CLI 自己会挂的外部服务（./discover.ts）；
 * 2. 能代理时经面板的连接池（server/mcp-client/pool.ts）问一遍工具表，问不到的、协议不支持的、最近代理出过错的退回直接挂；
 * 3. ExposurePolicy（shared/mcp-proxy/exposure.ts）定每个服务怎么给、哪些工具被能力接管不给；
 * 4. 交给 invoke：面板服务上挂代理会话（./serve.ts 接 more_tools 的调用），CLI 参数加「只挂面板」再把退回的服务逐个带上。
 * 任何一步出错都退回原来的做法（不加「只挂面板」，外部服务照旧由 CLI 自己读配置挂上），只记日志：代理不能让 Agent 少工具
 */
import type { CliDefinition } from '../../shared/clis.ts'
import type { Orchestra } from '../../shared/engine/host.ts'
import { exposurePlan, externalClaims, type ServerFacts } from '../../shared/mcp-proxy/exposure.ts'
import { proxyName } from '../../shared/mcp-proxy/names.ts'
import { mcpInjectArgs } from '../../shared/mcp-library/inject.ts'
import type { CallableServer } from '../mcp-client/call.ts'
import { listMcpTools, type McpToolDef } from '../mcp-client/pool.ts'
import type { LibraryEntry } from '../mcp-library/file.ts'
import { orchTools } from '../panel-tools/registry.ts'
import { pluginFindSources } from '../plugins/find-sources.ts'
import { readHooks } from '../hooks/store.ts'
import { log } from '../log.ts'
import { proxyCandidates, type ProxyCandidate } from './discover.ts'
import { noteExposure, recentFailure } from './state.ts'
import type { ProxySession } from './session.ts'

/** 开跑前问工具表最多等多久：连接池里有现成的会话时几毫秒，冷启动的 stdio 服务等不到这一轮就先直接挂 */
export const LIST_WAIT_MS = 5000

export interface RunProxy {
  /** 有服务经代理时才有：挂到面板服务上 */
  session?: ProxySession
  /**
   * 这一轮 CLI 参数里 MCP 那几项：mounted 是面板服务真的接上了（配置没写成时照旧，免得 CLI 一个服务都没有）。
   * 返回 undefined 时调用方按原来的做法带「按项目」条目
   */
  args(mounted: boolean, taken: string[]): string[] | undefined
}

export interface ProxyRunOpts {
  cwd: string
  projectId: string
  taskTitle: string
  orch?: Orchestra
  projectMcp?: LibraryEntry[]
  /** 插件的服务（这一轮自己的，不算外部服务） */
  own: string[]
}

const timeout = (ms: number) =>
  new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`${ms / 1000} 秒内没答出工具表`)), ms).unref?.())

/** HTTP 4xx、回的不是 JSON：服务在，但不是面板客户端会说的协议（例如只有旧的 SSE 端点） */
const isProtocolError = (e: Error) => /^HTTP 4\d\d\b/.test(e.message) || e instanceof SyntaxError

async function factsOf(c: ProxyCandidate, defs: Map<string, McpToolDef>, ask: boolean): Promise<ServerFacts> {
  const base = { name: c.name, source: c.source }
  if (!ask) return { ...base, state: 'ok', tools: [] }
  const failed = recentFailure(c.name)
  if (failed) return { ...base, state: 'failed', detail: failed.why, tools: [] }
  try {
    const tools = await Promise.race([listMcpTools(c.server, c.cwd), timeout(LIST_WAIT_MS)])
    for (const t of tools) defs.set(proxyName(c.name, t.name), t)
    return { ...base, state: 'ok', tools: tools.map((t) => t.name) }
  } catch (e) {
    const err = e as Error
    return { ...base, state: isProtocolError(err) ? 'protocol' : 'unreachable', detail: err.message, tools: [] }
  }
}

export async function proxyForRun(def: CliDefinition, o: ProxyRunOpts): Promise<RunProxy | undefined> {
  try {
    const enabled = (await readHooks()).gateway.mcpProxy
    const cliCan = !!def.takeover?.mcpOnlyPanel?.length && !!def.mcpStore?.inject
    const panel = !!o.orch
    const ask = enabled && cliCan && panel
    const cands = await proxyCandidates(def, o.cwd, o.projectMcp, o.own)
    const defs = new Map<string, McpToolDef>()
    const facts = await Promise.all(cands.map((c) => factsOf(c, defs, ask)))
    const sources = ask ? await pluginFindSources({ id: o.projectId, path: o.cwd }).catch(() => []) : []
    const plan = exposurePlan({
      enabled,
      cliCan,
      panel,
      panelTools: o.orch ? orchTools(o.orch).map((x) => x.name) : [],
      servers: facts,
      claims: externalClaims(sources.map((s) => ({ tool: s.tool, by: s.id.split(':')[0] }))),
    })
    void noteExposure({ projectId: o.projectId, cli: def.id, taskTitle: o.taskTitle, at: Date.now(), plan })
    for (const s of plan.servers)
      if (s.why === 'unreachable' || s.why === 'protocol')
        log.warn('mcp-proxy', `${s.name} 代理不了，这一轮直接挂在 ${def.name} 上`, { why: s.why, detail: s.detail })
    if (!plan.proxy) return undefined
    const byName = new Map(cands.map((c) => [c.name, c]))
    const servers = new Map<string, CallableServer>()
    for (const s of plan.servers)
      if (s.mode === 'proxy') {
        const c = byName.get(s.name)!
        servers.set(s.name, { name: s.name, server: c.server, cwd: c.cwd, tools: s.tools.map((x) => x.name) })
      }
    const session: ProxySession = { plan, defs, servers, projectId: o.projectId, dirs: [o.cwd] }
    const direct = plan.servers.filter((s) => s.mode === 'direct').map((s) => byName.get(s.name)!)
    return {
      session,
      args: (mounted, taken) =>
        mounted
          ? [
              ...def.takeover!.mcpOnlyPanel!,
              ...mcpInjectArgs(
                def.mcpStore,
                direct.filter((c) => !taken.includes(c.name)).map((c) => c.server),
              ),
            ]
          : undefined,
    }
  } catch (e) {
    log.warn('mcp-proxy', '外部服务代理没算出来，这一轮照旧直接挂', { error: (e as Error).message })
    return undefined
  }
}
