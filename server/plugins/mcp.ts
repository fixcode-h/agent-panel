import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { McpCallContext, McpResult, McpTool } from './sdk.ts'
import { log } from '../log.ts'
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

interface Session {
  pluginId: string
  server: string
  taskId: string
  tools: () => McpTool[] | Promise<McpTool[]>
  confirm?: McpCallContext['confirm']
}

const sessions = new Map<string, Session>()

/** 开一个会话：返回给 CLI 的服务名和地址；这一轮结束时 close */
export function openPluginMcp(
  pluginId: string,
  server: string,
  taskId: string,
  tools: () => McpTool[] | Promise<McpTool[]>,
  confirm?: McpCallContext['confirm'],
) {
  const token = randomUUID()
  sessions.set(token, { pluginId, server, taskId, tools, confirm })
  const port = Number(process.env.PORT ?? 8787)
  return {
    name: server,
    url: `http://127.0.0.1:${port}/api/plugins/mcp/${token}`,
    close: () => sessions.delete(token),
  }
}

/** 插件关掉时：它开着的会话全部作废（下一次调用回「这一轮已经结束了」） */
export function closePluginMcp(pluginId: string) {
  for (const [token, s] of sessions) if (s.pluginId === pluginId) sessions.delete(token)
}

/** 一条 JSON-RPC 请求；通知（没有 id）返回 undefined */
async function handle(s: Session, msg: any) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
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
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const tool = (await s.tools()).find((x) => x.name === name)
      if (!tool) return reply(mcpText(`没有这个工具：${name}`, true))
      try {
        const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}
        const res = await tool.call(args, { taskId: s.taskId, callId: String(msg.id), confirm: s.confirm })
        // 结果太长的存文件、只回头尾和路径（mcp-clip.ts）：插件结果进了会话就一直占着上下文
        return reply(await clipPluginResult(res, `plugin-${s.server}-${name}-${Date.now()}`, saveToHandoff(s.taskId)))
      } catch (e) {
        // 插件工具出错原样交给 Agent（不悄悄重试），日志里也记一笔方便排查
        log.warn('plugin', `插件工具出错：${s.pluginId}/${name}`, { error: (e as Error).message })
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
