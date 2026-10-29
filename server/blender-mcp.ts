import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { sceneText } from '../shared/blender.ts'
import { runPython, sceneObjects } from './blender.ts'

/**
 * 给模型对话的 Agent 用的 Blender 工具（MCP，Streamable HTTP），见 docs/adr/0025-model-design-blender.md。
 * 和设计工具（design-mcp.ts）一样：每轮对话开一个会话，地址里带随机令牌，只在这一轮有效；面板只监听本机。
 * 只给两个工具：bpy 代码能做 Blender 能做的一切，不为每种操作单独设计工具。
 */

const sessions = new Map<string, { taskId: string }>()

export function openBlenderSession(taskId: string) {
  const token = randomUUID()
  sessions.set(token, { taskId })
  const port = Number(process.env.PORT ?? 8787)
  return {
    url: `http://127.0.0.1:${port}/api/mcp/blender/${token}`,
    close: () => sessions.delete(token),
  }
}

const TOOLS = [
  {
    name: 'blender_python',
    description:
      '在当前模型的 Blender 场景里执行一段 Python（bpy）代码。可以直接用 bpy、bmesh、mathutils、math、Vector；上一段定义的变量和函数下一段还能用。' +
      '执行完场景自动保存，用户网页上的预览随之刷新。返回 print 的输出、报错（只含你的代码那一段的栈）和执行后的物体列表。' +
      '大的模型分几步做：先搭主体，看一眼结果，再加细节和材质。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 bpy 代码' },
      },
      required: ['code'],
    },
  },
  {
    name: 'blender_scene',
    description: '看现在场景里有哪些物体：名字、类型、位置、尺寸（米）、父级、面数、材质和修改器。',
    inputSchema: { type: 'object', properties: {} },
  },
]

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

async function callTool(taskId: string, name: string, args: Record<string, unknown>) {
  try {
    if (name === 'blender_python') {
      const code = String(args.code ?? '')
      if (!code.trim()) return text('code 是空的', true)
      const r = await runPython(taskId, code)
      const out = [
        r.ok ? '执行成功。' : '执行出错（场景已经按执行到出错为止的样子保存）。',
        r.output.trim() ? `输出：\n${r.output.trim()}` : '',
        r.error ? `报错：\n${r.error.trim()}` : '',
        r.meta.exportError ? `导出预览失败：${r.meta.exportError}` : '',
        `现在的场景（第 ${r.meta.version} 版，用户网页上已刷新）：\n${sceneText(r.meta.objects)}`,
      ]
      return text(out.filter(Boolean).join('\n\n'), !r.ok)
    }
    if (name === 'blender_scene') return text(sceneText(await sceneObjects(taskId)))
    return text(`没有这个工具：${name}`, true)
  } catch (e) {
    return text((e as Error).message, true)
  }
}

/** 一条 JSON-RPC 请求；通知（没有 id）返回 undefined */
async function handle(taskId: string, msg: any) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  if (msg?.id === undefined || msg?.id === null) return undefined
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-panel-blender', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call':
      return reply(await callTool(taskId, String(msg.params?.name ?? ''), msg.params?.arguments ?? {}))
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } }
  }
}

export function blenderMcpApi() {
  return (
    new Hono()
      .post('/blender/:token', async (c) => {
        const s = sessions.get(c.req.param('token'))
        if (!s) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '这一轮已经结束了' } }, 404)
        const body = await c.req.json().catch(() => null)
        const out = Array.isArray(body)
          ? (await Promise.all(body.map((m) => handle(s.taskId, m)))).filter(Boolean)
          : await handle(s.taskId, body)
        if (!out || (Array.isArray(out) && !out.length)) return c.body(null, 202)
        return c.json(out)
      })
      // 不推送服务端消息：GET 打开事件流的请求按协议回 405
      .get('/blender/:token', (c) => c.body(null, 405))
      .delete('/blender/:token', (c) => c.body(null, 200))
  )
}
