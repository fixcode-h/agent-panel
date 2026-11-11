import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { McpCallContext, McpResult, McpTool } from './sdk.ts'
import { log } from '../log.ts'
import { notePluginEffect } from './effects.ts'
import { clipPluginResult, saveToHandoff } from './mcp-clip.ts'

/**
 * 插件给 Agent 的 MCP 工具（Streamable HTTP，ADR 0059）。和设计工具、原来的 Blender 工具一样：
 * 每轮对话开一个会话，地址里带随机令牌，只在这一轮有效；面板只监听本机，接口自己核对令牌（auth.ts 放行这个前缀）。
 * 插件只给工具定义和执行函数（server/plugins/sdk.ts），协议在这里统一处理。
 */

export type { McpCallContext, McpContent, McpResult, McpTool } from './sdk.ts'

export const mcpText = (text: string, isError = false): McpResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError } : {}),
})

/**
 * 这一轮对话交给插件会话的钩子（插件接口 3，见 sdk.ts 的 McpToolEffect）：runner 装上
 * - guardEdit：改文件类工具执行前过工具前守卫，拒绝时返回原因；
 * - changed：改文件类工具成功改了这些文件（本机绝对路径），记成这一轮的改动
 */
export interface PluginRunHooks {
  cwd: string
  guardEdit?: (tool: string, paths: string[], input: Record<string, unknown>) => Promise<string>
  changed?: (files: string[]) => void
  /** 工具报进度（ctx.progress）：写进对话里这次调用那一行（插件框架改进 G2） */
  progress?: (server: string, tool: string, text: string) => void
}

interface Session {
  pluginId: string
  server: string
  taskId: string
  tools: () => McpTool[] | Promise<McpTool[]>
  confirm?: McpCallContext['confirm']
  hooks?: PluginRunHooks
  /** 正在跑的调用（JSON-RPC id → 取消用的控制器）：这一轮结束、插件关掉、CLI 发取消时 abort（插件框架改进 A3） */
  running: Map<string, AbortController>
}

const sessions = new Map<string, Session>()

/** 会话作废：正在跑的调用都取消，插件按 ctx.signal 停掉自己起的进程 */
function endSession(token: string) {
  const s = sessions.get(token)
  sessions.delete(token)
  for (const c of s?.running.values() ?? []) c.abort(new Error('这一轮已经结束了'))
}

/** 开一个会话：返回给 CLI 的服务名和地址；这一轮结束时 close */
export function openPluginMcp(
  pluginId: string,
  server: string,
  taskId: string,
  tools: () => McpTool[] | Promise<McpTool[]>,
  confirm?: McpCallContext['confirm'],
  hooks?: PluginRunHooks,
) {
  const token = randomUUID()
  sessions.set(token, { pluginId, server, taskId, tools, confirm, hooks, running: new Map() })
  const port = Number(process.env.PORT ?? 8787)
  return {
    name: server,
    url: `http://127.0.0.1:${port}/api/plugins/mcp/${token}`,
    close: () => endSession(token),
  }
}

/** 插件关掉时：它开着的会话全部作废（下一次调用回「这一轮已经结束了」） */
export function closePluginMcp(pluginId: string) {
  for (const [token, s] of sessions) if (s.pluginId === pluginId) endSession(token)
}

/** 插件算要改哪些文件时出错不拦调用：按算不出（空数组）交给守卫 */
function safeTargets(tool: McpTool, args: Record<string, unknown>) {
  try {
    return (tool.targets?.(args) ?? []).filter((x) => typeof x === 'string' && x.trim())
  } catch {
    return []
  }
}

/** 调用结束：按声明记下改了什么、验证得怎么样（effects.ts），改了的文件交给 runner 记成这一轮的改动 */
function settle(s: Session, tool: McpTool, r: Pick<McpResult, 'isError' | 'changed' | 'verified'>) {
  if (!tool.effect || tool.effect === 'read' || !s.hooks) return
  const files = notePluginEffect(s.taskId, s.hooks.cwd, s.server, tool, r)
  if (files.length) s.hooks.changed?.(files)
}

/**
 * 调插件工具：带上取消信号；声明了 timeoutSec 的到时间按出错返回并取消。
 * 被取消（这一轮结束、CLI 取消）时插件可能还没返回，这里不等它：按出错交回，反正 CLI 那边已经不收了
 */
async function callTool(s: Session, tool: McpTool, args: Record<string, unknown>, callId: string) {
  const ctl = new AbortController()
  s.running.set(callId, ctl)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const stopped = new Promise<never>((_, reject) => {
      const fail = () => reject(ctl.signal.reason instanceof Error ? ctl.signal.reason : new Error('调用被取消'))
      if (ctl.signal.aborted) fail()
      else ctl.signal.addEventListener('abort', fail, { once: true })
      if (tool.timeoutSec && tool.timeoutSec > 0)
        timer = setTimeout(
          () => ctl.abort(new Error(`工具 ${tool.name} 超过 ${tool.timeoutSec} 秒没有完成，已取消`)),
          tool.timeoutSec * 1000,
        )
    })
    return await Promise.race([
      tool.call(args, {
        taskId: s.taskId,
        callId,
        confirm: s.confirm,
        signal: ctl.signal,
        ...(s.hooks?.progress && {
          progress: (text: string) => {
            // 取消之后的进度不再写：那一行已经结束了
            if (!ctl.signal.aborted) s.hooks?.progress?.(s.server, tool.name, String(text))
          },
        }),
      }),
      stopped,
    ])
  } finally {
    clearTimeout(timer)
    s.running.delete(callId)
  }
}

/** 一条 JSON-RPC 请求；通知（没有 id）返回 undefined */
async function handle(s: Session, msg: any) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  // CLI 取消某次调用（MCP 的 notifications/cancelled，用户在 CLI 里打断时会发）：那次调用的 signal 触发
  if (msg?.method === 'notifications/cancelled') {
    s.running.get(String(msg.params?.requestId))?.abort(new Error(String(msg.params?.reason ?? '调用被取消')))
    return undefined
  }
  if (msg?.id === undefined || msg?.id === null) return undefined
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: `agent-panel-${s.server}`, version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list': {
      const tools = await s.tools()
      return reply({
        tools: tools.map(({ name, description, inputSchema, effect }) => ({
          name,
          description,
          inputSchema,
          // 声明了作用的按 MCP 的工具注解告诉 CLI：只读的不改环境，改文件的会改
          ...(effect && { annotations: { readOnlyHint: effect !== 'edit' } }),
        })),
      })
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const tool = (await s.tools()).find((x) => x.name === name)
      if (!tool) return reply(mcpText(`没有这个工具：${name}`, true))
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}
      try {
        // 改文件类工具先过工具前守卫（只读身份、Bug 先诊断、独立分支越界、凭据……），和 CLI 自己的改文件工具同一套
        if (tool.effect === 'edit' && s.hooks?.guardEdit) {
          const deny = await s.hooks.guardEdit(`${s.server} · ${name}`, safeTargets(tool, args), args)
          if (deny) return reply(mcpText(deny, true))
        }
        const r = await callTool(s, tool, args, String(msg.id))
        settle(s, tool, r)
        const { changed: _c, verified: _v, ...res } = r
        // 结果太长的存文件、只回头尾和路径（mcp-clip.ts）：插件结果进了会话就一直占着上下文
        return reply(await clipPluginResult(res, `plugin-${s.server}-${name}-${Date.now()}`, saveToHandoff(s.taskId)))
      } catch (e) {
        // 插件工具出错原样交给 Agent（不悄悄重试），日志里也记一笔方便排查；验证类工具出错按没通过记
        log.warn('plugin', `插件工具出错：${s.pluginId}/${name}`, { error: (e as Error).message })
        settle(s, tool, { isError: true })
        return reply(mcpText((e as Error).message, true))
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } }
  }
}

/** 挂在 /api/plugins/mcp 下 */
export function pluginMcpApi() {
  return (
    new Hono()
      .post('/:token', async (c) => {
        const s = sessions.get(c.req.param('token'))
        if (!s) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '这一轮已经结束了' } }, 404)
        const body = await c.req.json().catch(() => null)
        const out = Array.isArray(body)
          ? (await Promise.all(body.map((m) => handle(s, m)))).filter(Boolean)
          : await handle(s, body)
        if (!out || (Array.isArray(out) && !out.length)) return c.body(null, 202)
        return c.json(out)
      })
      // 不推送服务端消息：GET 打开事件流的请求按协议回 405
      .get('/:token', (c) => c.body(null, 405))
      .delete('/:token', (c) => c.body(null, 200))
  )
}
