import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AiImage, DesignQuestion, resolveDesignResult, type Design } from '../shared/design.ts'
import { applyOp, type OpsState } from '../shared/design-ops.ts'
import { compactTree } from '../shared/umg.ts'

/**
 * 给 CLI 用的设计工具（MCP，Streamable HTTP）：AI 不用把改动写成一大段 JSON，
 * 而是像在控件树和属性面板里操作一样调用工具——看当前的树、加控件、改属性、建子控件、列出要生成的图、检查。
 * 每次改动马上应用到这一轮的副本上，页面实时显示；这一轮结束、整体检查通过后才真正存下。
 *
 * 每轮 AI 对话开一个会话，地址里带随机令牌，只在这一轮有效；面板只监听本机。
 * CLI 连不上（版本太旧、不支持）时，AI 照旧按提示词把操作写在回复的 JSON 里，结果一样。
 */

interface Session {
  design: Design
  state: OpsState
  images: z.infer<typeof AiImage>[]
  /** 整体风格、设计稿尺寸：工具改了才有 */
  style?: string
  designSize?: { X: number; Y: number }
  /** 风格还没定时先问用户（ask_style） */
  question?: DesignQuestion
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

// 各个工具共用的参数说明
const IN = { type: 'string', description: '在哪个子控件（Widget Blueprint）里改，写子控件名；主界面不写' }
const WIDGET = {
  type: 'object',
  description:
    '控件：{"Type":"TextBlock","Name":"Txt_Title","Properties":{…},"Slot":{…},"Children":[…]}，只写和默认值不一样的属性，可以带子控件',
}
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})

const TOOLS = [
  {
    name: 'get_tree',
    description:
      '看当前的控件树（只列和默认值不一样的属性）。in 写子控件名看子控件的树，不写看主界面；all 为 true 时连同所有子控件一起返回。',
    inputSchema: obj({ in: IN, all: { type: 'boolean' } }),
  },
  {
    name: 'get_design',
    description: '看设计的概况：设计稿尺寸、整体风格、子控件列表、已有图片和这一轮列出的图片。',
    inputSchema: obj({}),
  },
  {
    name: 'add_widget',
    description: '在 parent 下加一个控件（可以带子控件）。index 是放在第几个，不写放最后。控件名在同一棵树里不能重复。',
    inputSchema: obj({ in: IN, parent: { type: 'string' }, index: { type: 'integer' }, widget: WIDGET }, [
      'parent',
      'widget',
    ]),
  },
  {
    name: 'update_widget',
    description:
      '改一个控件的属性和插槽：properties、slot 只写要改的字段，和原来的深合并（例如 {"Text":"背包"}、{"Padding":{"Top":24}}）。UserWidget 换引用的子控件写 class。',
    inputSchema: obj(
      {
        in: IN,
        name: { type: 'string' },
        properties: { type: 'object' },
        slot: { type: 'object' },
        class: { type: 'string' },
      },
      ['name'],
    ),
  },
  {
    name: 'remove_widget',
    description: '删掉一个控件（连同它的子控件）。',
    inputSchema: obj({ in: IN, name: { type: 'string' } }, ['name']),
  },
  {
    name: 'move_widget',
    description: '把控件移到 parent 下的第 index 个（不写放最后），也可以用来在同一个父控件里调整顺序。',
    inputSchema: obj({ in: IN, name: { type: 'string' }, parent: { type: 'string' }, index: { type: 'integer' } }, [
      'name',
      'parent',
    ]),
  },
  {
    name: 'rename_widget',
    description: '给控件改名（英文 PascalCase）。',
    inputSchema: obj({ in: IN, name: { type: 'string' }, to: { type: 'string' } }, ['name', 'to']),
  },
  {
    name: 'replace_widget',
    description: '把一个控件（连同子控件）整个换成新的；新控件不写 Slot 就沿用原来的。换根控件就是整个重做这棵树。',
    inputSchema: obj({ in: IN, name: { type: 'string' }, widget: WIDGET }, ['name', 'widget']),
  },
  {
    name: 'create_component',
    description:
      '新建一个子控件（Widget Blueprint，例如列表条目、背包格子），root 是它的控件树。之后用 in 往里加控件，在树里用 {"Type":"UserWidget","Class":"<子控件名>"} 引用。',
    inputSchema: obj(
      {
        name: { type: 'string', description: '例如 WBP_ItemSlot' },
        size: obj({ X: { type: 'number' }, Y: { type: 'number' } }),
        root: WIDGET,
      },
      ['name', 'root'],
    ),
  },
  {
    name: 'resize_component',
    description: '改子控件的设计尺寸。',
    inputSchema: obj({ name: { type: 'string' }, size: obj({ X: { type: 'number' }, Y: { type: 'number' } }) }, [
      'name',
      'size',
    ]),
  },
  {
    name: 'delete_component',
    description: '删掉一个子控件。',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
  },
  {
    name: 'edit',
    description:
      '一次提交多步修改（op 为 set / add / remove / move / rename / replace / addComponent / removeComponent / resizeComponent，格式见提示词）。改很多地方时比一个个调用快。成功的马上生效，失败的返回原因。',
    inputSchema: obj({ ops: { type: 'array', items: { type: 'object' } } }, ['ops']),
  },
  {
    name: 'add_images',
    description:
      '列出这次要新建或重新生成的图片（id、name、prompt、width、height、transparent、nineSlice）；同一个 id 再提交会覆盖。图片要设到控件上（"img:<id>"）才会显示。',
    inputSchema: obj({ images: { type: 'array', items: { type: 'object' } } }, ['images']),
  },
  {
    name: 'set_style',
    description: '写下整体美术风格（英文，生成每张图时都会带上）。',
    inputSchema: obj({ style: { type: 'string' } }, ['style']),
  },
  {
    name: 'set_design_size',
    description: '改设计稿尺寸（主界面的宽高，像素）。',
    inputSchema: obj({ X: { type: 'number' }, Y: { type: 'number' } }, ['X', 'Y']),
  },
  {
    name: 'ask_style',
    description:
      '整体风格还没定、用户也没说清楚时，先问用户想要什么风格：给 3~4 个选项，每个写 label（中文，10 个字以内）、desc（一句话说明画面感觉）、style（选了以后用的英文风格描述）。问了就不要再改设计，回复一句为什么先问。',
    inputSchema: obj(
      {
        text: { type: 'string' },
        options: {
          type: 'array',
          items: obj({ label: { type: 'string' }, desc: { type: 'string' }, style: { type: 'string' } }),
        },
      },
      ['text', 'options'],
    ),
  },
  {
    name: 'check',
    description:
      '检查当前设计有没有问题（控件放法、引用的子控件和图片、没用上的图、默认文字）。改完后调一次，没问题再回复用户。',
    inputSchema: obj({}),
  },
]

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/** 应用几步操作，返回给 AI 看的结果 */
function apply(s: Session, ops: unknown[]) {
  const lines: string[] = []
  let ok = 0
  ops.forEach((op, i) => {
    const r = applyOp(s.state, op)
    if ('error' in r) lines.push(ops.length > 1 ? `ops[${i}] 失败：${r.error}` : r.error)
    else {
      s.state = r.state
      ok++
    }
  })
  s.applied += ok
  if (ok) s.onChange(s)
  if (ops.length === 1) return ok ? text('好了') : text(lines[0], true)
  return text([`成功 ${ok} 条，失败 ${ops.length - ok} 条`, ...lines].join('\n'), ok === 0)
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const size = (v: any) => (v && v.X > 0 && v.Y > 0 ? { X: Number(v.X), Y: Number(v.Y) } : undefined)

/** 当前设计（加上这一轮的改动）的检查 */
export function checkSession(s: Session) {
  return resolveDesignResult(
    { reply: '', images: s.images, ops: [] },
    { ...s.design, root: s.state.root, components: s.state.components },
  )
}

function callTool(s: Session, name: string, args: any) {
  const a = args && typeof args === 'object' ? args : {}
  const at = str(a.in) ? { in: str(a.in) } : {}
  switch (name) {
    case 'get_tree': {
      if (a.all)
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
      const comp = a.in ? s.state.components.find((c) => c.Name === a.in) : undefined
      if (a.in && !comp) return text(`没有子控件 ${a.in}`, true)
      return text(JSON.stringify(compactTree(comp ? comp.Root : s.state.root)))
    }
    case 'get_design':
      return text(
        JSON.stringify({
          designSize: s.designSize ?? s.design.designSize,
          style: s.style ?? s.design.style,
          components: s.state.components.map((c) => ({ Name: c.Name, DesignSize: c.DesignSize })),
          images: s.design.images.map((i) => ({
            id: i.id,
            name: i.name,
            size: `${i.width}x${i.height}`,
            generated: i.variants.length > 0,
          })),
          newImages: s.images.map((i) => i.id),
        }),
      )
    case 'add_widget':
      return apply(s, [{ op: 'add', ...at, parent: a.parent, index: a.index, widget: a.widget }])
    case 'update_widget': {
      const ops: unknown[] = []
      if (a.properties && typeof a.properties === 'object')
        ops.push({ op: 'set', ...at, target: a.name, path: 'Properties', value: a.properties })
      if (a.slot && typeof a.slot === 'object')
        ops.push({ op: 'set', ...at, target: a.name, path: 'Slot', value: a.slot })
      if (str(a.class)) ops.push({ op: 'set', ...at, target: a.name, path: 'Class', value: a.class })
      if (!ops.length) return text('properties、slot、class 至少写一个', true)
      return apply(s, ops)
    }
    case 'remove_widget':
      return apply(s, [{ op: 'remove', ...at, target: a.name }])
    case 'move_widget':
      return apply(s, [{ op: 'move', ...at, target: a.name, parent: a.parent, index: a.index }])
    case 'rename_widget':
      return apply(s, [{ op: 'rename', ...at, target: a.name, name: a.to }])
    case 'replace_widget':
      return apply(s, [{ op: 'replace', ...at, target: a.name, widget: a.widget }])
    case 'create_component':
      return apply(s, [{ op: 'addComponent', component: { Name: a.name, DesignSize: size(a.size), Root: a.root } }])
    case 'resize_component':
      return apply(s, [{ op: 'resizeComponent', name: a.name, size: a.size }])
    case 'delete_component':
      return apply(s, [{ op: 'removeComponent', name: a.name }])
    case 'edit': {
      const ops = Array.isArray(a.ops) ? a.ops : []
      if (!ops.length) return text('ops 是空的', true)
      return apply(s, ops)
    }
    case 'add_images': {
      const p = z.array(AiImage).safeParse(a.images)
      if (!p.success) return text(z.prettifyError(p.error), true)
      for (const img of p.data) s.images = [...s.images.filter((x) => x.id !== img.id), img]
      return text(`已记下 ${p.data.length} 张图片：${p.data.map((i) => i.id).join('、')}`)
    }
    case 'set_style':
      s.style = str(a.style)
      return text('好了')
    case 'set_design_size': {
      const v = size(a)
      if (!v) return text('X、Y 要是正数', true)
      s.designSize = v
      return text('好了')
    }
    case 'ask_style': {
      const p = DesignQuestion.safeParse(a)
      if (!p.success) return text(z.prettifyError(p.error), true)
      s.question = p.data
      return text('已记下，会在对话里给用户选。回复一句为什么先问，就结束这一轮。')
    }
    case 'check': {
      const r = checkSession(s)
      return text('error' in r ? r.error : '没有发现问题')
    }
    default:
      return text(`没有这个工具：${name}`, true)
  }
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
