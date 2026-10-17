import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AiImage, resolveDesignResult, type Design } from '../shared/design.ts'
import { applyOp, type OpsState } from '../shared/design-ops.ts'
import { compactTree } from '../shared/umg.ts'

/**
 * 给 CLI 用的设计工具（MCP，Streamable HTTP）：AI 不用把改动写成一大段 JSON，
 * 而是像在控件树和属性面板里操作一样调用工具——看当前的树、一步步改、列出要生成的图、检查。
 * 每次改动马上应用到这一轮的副本上，页面实时显示；这一轮结束、整体检查通过后才真正存下。
 *
 * 每轮 AI 对话开一个会话，地址里带随机令牌，只在这一轮有效；面板只监听本机。
 * CLI 连不上（版本太旧、不支持）时，AI 照旧按提示词把操作写在回复的 JSON 里，结果一样。
 */

interface Session {
  design: Design
  state: OpsState
  images: z.infer<typeof AiImage>[]
  /** 成功应用了几步 */
  applied: number
  onChange: (s: Session) => void
}

const sessions = new Map<string, Session>()

export function openDesignSession(design: Design, onChange: (s: Session) => void) {
  const token = randomUUID()
  const s: Session = {
    design,
    state: { root: design.root, components: design.components },
    images: [],
    applied: 0,
    onChange,
  }
  sessions.set(token, s)
  const port = Number(process.env.PORT ?? 8787)
  return {
    url: `http://127.0.0.1:${port}/api/mcp/design/${token}`,
    session: s,
    close: () => sessions.delete(token),
  }
}

const TOOLS = [
  {
    name: 'get_tree',
    description:
      '看当前的控件树（只列和默认值不一样的属性）。in 写子控件名看子控件的树，不写看主界面；all 为 true 时连同所有子控件一起返回。',
    inputSchema: {
      type: 'object',
      properties: { in: { type: 'string' }, all: { type: 'boolean' } },
    },
  },
  {
    name: 'edit',
    description:
      '按顺序执行一组修改操作（格式见提示词里的 ops：set / add / remove / move / rename / replace / addComponent / removeComponent / resizeComponent）。成功的马上生效，失败的返回原因，可以改了再提交。',
    inputSchema: {
      type: 'object',
      properties: { ops: { type: 'array', items: { type: 'object' } } },
      required: ['ops'],
    },
  },
  {
    name: 'add_images',
    description:
      '列出这次要新建或重新生成的图片（id、name、prompt、width、height、transparent、nineSlice），格式同提示词里的 images；同一个 id 再提交会覆盖。图片要用 edit 设到控件的画刷上（"img:<id>"）。',
    inputSchema: {
      type: 'object',
      properties: { images: { type: 'array', items: { type: 'object' } } },
      required: ['images'],
    },
  },
  {
    name: 'check',
    description:
      '检查当前设计有没有问题（控件放法、引用的子控件和图片、没用上的图、默认文字）。改完后调一次，没问题再回复用户。',
    inputSchema: { type: 'object', properties: {} },
  },
]

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

function callTool(s: Session, name: string, args: any) {
  if (name === 'get_tree') {
    if (args?.all)
      return text(
        JSON.stringify({
          root: compactTree(s.state.root),
          components: s.state.components.map((c) => ({
            Name: c.Name,
            DesignSize: c.DesignSize,
            Root: compactTree(c.Root),
          })),
        }),
      )
    const comp = args?.in ? s.state.components.find((c) => c.Name === args.in) : undefined
    if (args?.in && !comp) return text(`没有子控件 ${args.in}`, true)
    return text(JSON.stringify(compactTree(comp ? comp.Root : s.state.root)))
  }
  if (name === 'edit') {
    const ops = Array.isArray(args?.ops) ? args.ops : []
    if (!ops.length) return text('ops 是空的', true)
    const lines: string[] = []
    let ok = 0
    ops.forEach((op: unknown, i: number) => {
      const r = applyOp(s.state, op)
      if ('error' in r) lines.push(`ops[${i}] 失败：${r.error}`)
      else {
        s.state = r.state
        ok++
      }
    })
    s.applied += ok
    if (ok) s.onChange(s)
    return text([`成功 ${ok} 条，失败 ${ops.length - ok} 条`, ...lines].join('\n'), ok === 0)
  }
  if (name === 'add_images') {
    const p = z.array(AiImage).safeParse(args?.images)
    if (!p.success) return text(z.prettifyError(p.error), true)
    for (const img of p.data) s.images = [...s.images.filter((x) => x.id !== img.id), img]
    return text(`已记下 ${p.data.length} 张图片：${p.data.map((i) => i.id).join('、')}`)
  }
  if (name === 'check') {
    const r = resolveDesignResult(
      { reply: '', images: s.images, ops: [] },
      { ...s.design, root: s.state.root, components: s.state.components },
    )
    return text('error' in r ? r.error : '没有发现问题')
  }
  return text(`没有这个工具：${name}`, true)
}

/** 一条 JSON-RPC 请求；通知（没有 id）返回 undefined */
function handle(s: Session, msg: any) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  if (msg?.id === undefined || msg?.id === null) return undefined
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-panel-design', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call':
      return reply(callTool(s, String(msg.params?.name ?? ''), msg.params?.arguments ?? {}))
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } }
  }
}

export function designMcpApi() {
  return (
    new Hono()
      .post('/design/:token', async (c) => {
        const s = sessions.get(c.req.param('token'))
        if (!s)
          return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '这一轮设计已经结束了' } }, 404)
        const body = await c.req.json().catch(() => null)
        const out = Array.isArray(body) ? body.map((m) => handle(s, m)).filter(Boolean) : handle(s, body)
        // 只有通知时按协议回 202
        if (!out || (Array.isArray(out) && !out.length)) return c.body(null, 202)
        return c.json(out)
      })
      // 不推送服务端消息：GET 打开事件流的请求按协议回 405
      .get('/design/:token', (c) => c.body(null, 405))
      .delete('/design/:token', (c) => c.body(null, 200))
  )
}
