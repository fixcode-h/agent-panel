/**
 * 演示：外部 MCP 服务代理（ADR 0085）的「给 Agent 的工具」。演示里没有真的外部服务，几个服务问到的事实写死
 * （IDEA 问到了工具表、UEToVS 问到了、一个旧 SSE 服务协议不支持），怎么给、哪些工具被接管由 shared 里和服务端同一份 ExposurePolicy 算
 */
import { exposurePlan, externalClaims, type ServerFacts } from '@shared/mcp-proxy/exposure'
import { exposureView } from '@shared/mcp-proxy/view'
import type { ExposureRun } from '@shared/mcp-proxy/types'
import { fail } from './demo-http'

const FACTS: ServerFacts[] = [
  {
    name: 'idea',
    source: '.mcp.json',
    state: 'ok',
    tools: ['lua_code', 'lua_debug_session', 'lua_debug_breakpoints', 'lua_debug_inspect', 'get_file_problems'],
  },
  {
    name: 'uetovs',
    source: '~/.claude.json',
    state: 'ok',
    tools: ['search_symbols', 'get_class_hierarchy', 'debug_session', 'debug_breakpoints'],
  },
  {
    name: 'old-docs',
    source: '~/.claude.json',
    state: 'protocol',
    detail: 'HTTP 405',
    tools: [],
  },
]

/** 子对话、父对话有 find；只有四个工具的 Chat 对话没有，接管就不生效 */
const PANEL_TOOLS = ['find', 'end_turn', 'request_build', 'set_plan']

let enabled = true

/** 演示的几轮记在调用方选的项目上（演示里每个项目接的外部服务一样） */
function runs(projectId: string): ExposureRun[] {
  const claims = externalClaims()
  const now = Date.now()
  const claude = exposurePlan({ enabled, cliCan: true, panel: true, panelTools: PANEL_TOOLS, servers: FACTS, claims })
  const codex = exposurePlan({ enabled, cliCan: false, panel: true, panelTools: PANEL_TOOLS, servers: FACTS, claims })
  return [
    { projectId, cli: 'claude', taskTitle: '子对话 · 购物车日志', at: now - 60_000, plan: claude },
    { projectId, cli: 'codex', taskTitle: '工作流 · 背包重构 › 开发', at: now - 30 * 60_000, plan: codex },
  ]
}

export function demoMcpProxy(method: string, seg: string[], query: URLSearchParams, body: unknown): unknown {
  const sub = seg[1]
  if (sub === 'exposure') {
    return exposureView(enabled, runs(query.get('projectId') || 'demo-shop'), externalClaims())
  }
  if (sub === 'settings' && method === 'PUT') {
    enabled = !!(body as { enabled?: unknown })?.enabled
    return { enabled }
  }
  return fail('没有这个接口')
}
