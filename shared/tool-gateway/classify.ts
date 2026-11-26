/**
 * 认调用（CallClassifier，设计稿 7.1）：把钩子交来的事实（shared/hooks/index.ts 的 HookFacts，已经按 CLI 定义的 toolNames 归过类）
 * 归成统一的 ToolCall。只看工具名、参数和路径，不看模型回复的文字（ADR 0041、0049）。
 *
 * - shell：拆命令（./commands.ts），段数、程序名、类别；
 * - read 里 CLI 自带的搜索工具（Grep、Glob 这类）从 CLI 定义的 hooks.searchTools 认，不按 CLI 名字写分支；
 * - 面板自己的工具（钩子事实里 kind 已是 panel）记下去掉前缀的名字；
 * - 其余（hooks 里归成 any 的）：MCP 工具按 mcp__<服务>__<工具> 认，认不出时交给调用方给的 resolveMcp（服务端按已知的外部服务表认），
 *   都认不出算 other
 */
import type { HookFacts, HooksSpec } from '../hooks/index.ts'
import { parseCommand } from './commands.ts'
import type { ToolCall } from './types.ts'

export interface ClassifyOptions {
  cli: string
  spec?: Pick<HooksSpec, 'searchTools'>
  /** 不是 mcp__ 写法的 MCP 工具名（Pi 的裸名字、idea_lua_code 这类）由调用方按已知服务认 */
  resolveMcp?: (name: string, input: Record<string, unknown>) => { server: string; tool: string } | undefined
}

/** mcp__<服务>__<工具>：服务名里可能有 _，按最后一个 __ 切 */
export function splitMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice(5)
  const at = rest.lastIndexOf('__')
  if (at <= 0) return undefined
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

export function classifyCall(tool: NonNullable<HookFacts['tool']>, o: ClassifyOptions): ToolCall {
  const paths = (tool.paths.length ? tool.paths : [tool.path]).filter(Boolean)
  const base = { cli: o.cli, tool: tool.name, input: tool.input, paths }
  if (tool.kind === 'shell') return { ...base, kind: 'shell', command: parseCommand(String(tool.input.command ?? '')) }
  if (tool.kind === 'edit') return { ...base, kind: 'edit' }
  if (tool.kind === 'read')
    return { ...base, kind: 'read', ...(o.spec?.searchTools?.includes(tool.name) ? { search: true } : {}) }
  if (tool.kind === 'panel' || tool.panel) return { ...base, kind: 'panel', panel: tool.panel || tool.name }
  const mcp = splitMcpName(tool.name) ?? o.resolveMcp?.(tool.name, tool.input)
  if (mcp) return { ...base, kind: 'mcp', server: mcp.server, mcpTool: mcp.tool }
  return { ...base, kind: 'other' }
}

/** 记录里显示的一句：命令原文、路径或搜索词，截短 */
export function callSummary(c: ToolCall, max = 200): string {
  const s =
    c.kind === 'shell'
      ? String(c.input.command ?? '')
      : c.paths.length
        ? c.paths.join(' ')
        : ((['pattern', 'query', 'glob', 'name', 'command', 'action']
            .map((k) => c.input[k])
            .find((v) => typeof v === 'string' && v.trim()) as string | undefined) ?? '')
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

// 只读的面板工具名：常量表，不会改
const READ_PANEL = ['find', 'file_index', 'knowledge_lookup', 'get_status', 'read_state', 'read_messages']

/**
 * 只读调用：读文件、CLI 自带搜索、只读的命令（搜索、读文件、列目录）、面板的查找类工具。
 * 「本可以并行」只数这一类：它们互不依赖，本来可以在同一条回复里一起发
 */
export function readOnlyCall(c: Pick<ToolCall, 'kind' | 'command' | 'panel'>): boolean {
  if (c.kind === 'read') return true
  if (c.kind === 'shell') return c.command?.category === 'search' || c.command?.category === 'read'
  if (c.kind === 'panel') return READ_PANEL.includes(c.panel ?? '')
  return false
}
