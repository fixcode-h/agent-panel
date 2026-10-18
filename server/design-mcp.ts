import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AiImage, DesignQuestion, resolveDesignResult, type Design } from '../shared/design.ts'
import { applyOp, type OpsState } from '../shared/design-ops.ts'
import { compactTree } from '../shared/umg.ts'

/**
 * 给 CLI 用的设计工具（MCP，Streamable HTTP）：AI 像在控件树和属性面板里操作一样调用工具改设计。
 * 每个改动类的工具都能一次提交多条（items），一次调用就能搭好一整块界面，少来回、快很多；
 * 控件和插槽的写法宽松（见 design-ops.ts 的 looseWidget），少写错、少返工。
 * 每次改动马上应用到这一轮的副本上，页面实时显示；这一轮结束、整体检查通过后才真正存下。
 *
 * 每轮 AI 对话开一个会话，地址里带随机令牌，只在这一轮有效；面板只监听本机。
 */

interface Session {
  design: Design
  state: OpsState
  images: z.infer<typeof AiImage>[]
  /** 整体风格、设计稿尺寸：工具改了才有 */
  style?: string
  designSize?: { X: number; Y: number }
  /** 动手之前先问用户的问题（ask_user），一次可以问几个 */
  questions?: DesignQuestion[]
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
    '控件：{"Type":"TextBlock","Name":"Txt_Title","Text":"背包","Slot":{…},"Children":[…]}。Type、Name、Slot、Children、Class 以外的键都是属性（也可以写在 Properties 里），只写和默认值不一样的；可以带子控件，一次搭好一整块',
}
const SIZE = { type: 'object', properties: { X: { type: 'number' }, Y: { type: 'number' } } }
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})
/** 批量的工具：items 里每一项是一条 */
const batch = (item: Record<string, unknown>, required: string[], extra: Record<string, unknown> = {}) =>
  obj({ items: { type: 'array', items: obj(item, required) }, ...extra }, ['items'])
const NAMES = obj({ names: { type: 'array', items: { type: 'string' } }, in: IN }, ['names'])

const TOOLS = [
  {
    name: 'get_tree',
    description:
      '看当前的控件树（只列和默认值不一样的属性）。提示词里已经有开始时的树，一般不用调；in 写子控件名看子控件的树，all 为 true 时连同所有子控件一起返回。',
    inputSchema: obj({ in: IN, all: { type: 'boolean' } }),
  },
  {
    name: 'get_design',
    description: '看设计的概况：设计稿尺寸、整体风格、子控件列表、已有图片和这一轮列出的图片。',
    inputSchema: obj({}),
  },
  {
    name: 'add_widgets',
    description:
      '加控件，一次可以加很多个：每项把 widget（可以带整棵子树）放到 parent 下的第 index 个（不写放最后）。控件名在同一棵树里不能重复。',
    inputSchema: batch({ parent: { type: 'string' }, widget: WIDGET, index: { type: 'integer' }, in: IN }, [
      'parent',
      'widget',
    ]),
  },
  {
    name: 'update_widgets',
    description:
      '改控件的属性和插槽，一次可以改很多个：properties、slot 只写要改的字段，和原来的合并（例如 {"Text":"背包"}、{"padding":[0,24,0,0]}）。UserWidget 换引用的子控件写 class。',
    inputSchema: batch(
      {
        name: { type: 'string' },
        properties: { type: 'object' },
        slot: { type: 'object' },
        class: { type: 'string' },
        in: IN,
      },
      ['name'],
    ),
  },
  { name: 'remove_widgets', description: '删掉控件（连同子控件），names 一次写多个。', inputSchema: NAMES },
  {
    name: 'move_widgets',
    description: '把控件移到 parent 下的第 index 个（不写放最后），也用来调整顺序。',
    inputSchema: batch({ name: { type: 'string' }, parent: { type: 'string' }, index: { type: 'integer' }, in: IN }, [
      'name',
      'parent',
    ]),
  },
  {
    name: 'rename_widgets',
    description: '给控件改名（英文 PascalCase）。',
    inputSchema: batch({ name: { type: 'string' }, to: { type: 'string' }, in: IN }, ['name', 'to']),
  },
  {
    name: 'replace_widget',
    description:
      '把一个控件（连同子控件）整个换成新的；不写 Slot 就沿用原来的。换根控件就是整个重做这棵树——从零搭一个界面时用它一次写完整棵树最快。',
    inputSchema: obj({ name: { type: 'string' }, widget: WIDGET, in: IN }, ['name', 'widget']),
  },
  {
    name: 'create_components',
    description:
      '新建子控件（Widget Blueprint，例如列表条目、背包格子），一次可以建多个：root 是它的整棵控件树，size 是设计尺寸。在树里用 {"Type":"UserWidget","Class":"<子控件名>"} 引用。',
    inputSchema: batch({ name: { type: 'string' }, size: SIZE, root: WIDGET }, ['name', 'root']),
  },
  {
    name: 'resize_components',
    description: '改子控件的设计尺寸。',
    inputSchema: batch({ name: { type: 'string' }, size: SIZE }, ['name', 'size']),
  },
  { name: 'delete_components', description: '删掉子控件，names 一次写多个。', inputSchema: NAMES },
  {
    name: 'add_images',
    description:
      '列出这次要新建或重新生成的图片（id、name、prompt、width、height、transparent、nineSlice）；同一个 id 再提交会覆盖。图片要设到控件上（"img:<id>"）才会显示。' +
      '很多同类的小图标（背包物品、技能、货币）写成一组：同一个 sheet（例如 "items"），面板会把它们画在一张图上再切开，快很多。',
    inputSchema: obj({ images: { type: 'array', items: { type: 'object' } } }, ['images']),
  },
  {
    name: 'set_design',
    description: 'style 写整体美术风格（英文，生成每张图时都会带上），designSize 改设计稿尺寸；只写要改的。',
    inputSchema: obj({ style: { type: 'string' }, designSize: SIZE }),
  },
  {
    name: 'ask_user',
    description:
      '动手之前先问用户（例如整体风格还没定），一次可以问几个问题，用户全部回答后一起交回来。每个问题写 question、header（4 个字以内的标签）、options（3~4 个，每个 label、desc；问风格时再写 style：选了以后用的英文风格描述），multiSelect 表示可以多选。用户总能自己输入别的答案。问了就不要再改设计，回复一句为什么先问。',
    inputSchema: obj(
      {
        questions: {
          type: 'array',
          items: obj(
            {
              question: { type: 'string' },
              header: { type: 'string' },
              multiSelect: { type: 'boolean' },
              options: {
                type: 'array',
                items: obj({ label: { type: 'string' }, desc: { type: 'string' }, style: { type: 'string' } }),
              },
            },
            ['question', 'options'],
          ),
        },
      },
      ['questions'],
    ),
  },
  {
    name: 'edit',
    description:
      '一次提交多步不同种类的修改（op 为 set / add / remove / move / rename / replace / addComponent / removeComponent / resizeComponent，格式见提示词）。',
    inputSchema: obj({ ops: { type: 'array', items: { type: 'object' } } }, ['ops']),
  },
  {
    name: 'check',
    description: '检查当前设计有没有问题（控件放法、引用的子控件和图片、没用上的图、默认文字）。改完后调一次。',
    inputSchema: obj({}),
  },
]

/** 以前的工具名（单个的）也认，免得 AI 照着旧习惯调用时报错 */
const ALIASES: Record<string, string> = {
  add_widget: 'add_widgets',
  update_widget: 'update_widgets',
  remove_widget: 'remove_widgets',
  move_widget: 'move_widgets',
  rename_widget: 'rename_widgets',
  create_component: 'create_components',
  resize_component: 'resize_components',
  delete_component: 'delete_components',
  set_style: 'set_design',
  set_design_size: 'set_design',
  ask_style: 'ask_user',
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/** 应用几步操作，返回给 AI 看的结果；失败的不影响其他的 */
function apply(s: Session, ops: unknown[]) {
  const lines: string[] = []
  let ok = 0
  ops.forEach((op, i) => {
    const r = applyOp(s.state, op)
    if ('error' in r) lines.push(ops.length > 1 ? `第 ${i + 1} 条失败：${r.error}` : r.error)
    else {
      s.state = r.state
      ok++
    }
  })
  s.applied += ok
  if (ok) s.onChange(s)
  if (ops.length === 1) return ok ? text('好了') : text(lines[0], true)
  return text(
    [
      ok === ops.length
        ? `${ok} 条全部成功`
        : `成功 ${ok} 条，失败 ${ops.length - ok} 条（成功的已经生效，只要改失败的）`,
      ...lines,
    ].join('\n'),
    ok === 0,
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const size = (v: any) => (v && v.X > 0 && v.Y > 0 ? { X: Number(v.X), Y: Number(v.Y) } : undefined)
/** 批量工具的每一项：写了 items 就是多项，没写当作一项；没写 in 的沿用外层的 */
const itemsOf = (a: any): any[] =>
  (Array.isArray(a.items) ? a.items : [a]).map((x: any) =>
    x && typeof x === 'object' && !x.in && a.in ? { ...x, in: a.in } : x,
  )
const namesOf = (a: any): string[] =>
  Array.isArray(a.names) ? a.names.map(String) : a.name ? [String(a.name)] : itemsOf(a).map((x) => str(x?.name))

/** 当前设计（加上这一轮的改动）的检查 */
export function checkSession(s: Session) {
  return resolveDesignResult(
    { reply: '', images: s.images, ops: [] },
    { ...s.design, root: s.state.root, components: s.state.components },
  )
}

/** AI 写的问题换成面板的格式 */
const toQuestion = (q: any): unknown => ({
  text: str(q?.question ?? q?.text),
  header: str(q?.header),
  multiSelect: !!q?.multiSelect,
  options: (Array.isArray(q?.options) ? q.options : []).map((o: any) =>
    typeof o === 'string'
      ? { label: o }
      : { label: str(o?.label), desc: str(o?.desc ?? o?.description), style: str(o?.style) },
  ),
})

function callTool(s: Session, raw: string, args: any) {
  const name = ALIASES[raw] ?? raw
  const a = args && typeof args === 'object' ? args : {}
  const at = (x: any) => (str(x?.in) ? { in: str(x.in) } : {})
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
    case 'add_widgets':
      return apply(
        s,
        itemsOf(a).map((x) => ({ op: 'add', ...at(x), parent: x?.parent, index: x?.index, widget: x?.widget })),
      )
    case 'update_widgets': {
      const ops: unknown[] = []
      for (const x of itemsOf(a)) {
        const props = x?.properties ?? x?.props
        if (props && typeof props === 'object')
          ops.push({ op: 'set', ...at(x), target: x.name, path: 'Properties', value: props })
        if (x?.slot && typeof x.slot === 'object')
          ops.push({ op: 'set', ...at(x), target: x.name, path: 'Slot', value: x.slot })
        if (str(x?.class)) ops.push({ op: 'set', ...at(x), target: x.name, path: 'Class', value: x.class })
      }
      if (!ops.length) return text('每项至少写 properties、slot、class 中的一个', true)
      return apply(s, ops)
    }
    case 'remove_widgets':
      return apply(
        s,
        namesOf(a).map((n) => ({ op: 'remove', ...at(a), target: n })),
      )
    case 'move_widgets':
      return apply(
        s,
        itemsOf(a).map((x) => ({ op: 'move', ...at(x), target: x?.name, parent: x?.parent, index: x?.index })),
      )
    case 'rename_widgets':
      return apply(
        s,
        itemsOf(a).map((x) => ({ op: 'rename', ...at(x), target: x?.name, name: x?.to })),
      )
    case 'replace_widget':
      return apply(
        s,
        itemsOf(a).map((x) => ({ op: 'replace', ...at(x), target: x?.name, widget: x?.widget })),
      )
    case 'create_components':
      return apply(
        s,
        itemsOf(a).map((x) => ({
          op: 'addComponent',
          component: { Name: x?.name, DesignSize: size(x?.size), Root: x?.root },
        })),
      )
    case 'resize_components':
      return apply(
        s,
        itemsOf(a).map((x) => ({ op: 'resizeComponent', name: x?.name, size: x?.size })),
      )
    case 'delete_components':
      return apply(
        s,
        namesOf(a).map((n) => ({ op: 'removeComponent', name: n })),
      )
    case 'edit': {
      const ops = Array.isArray(a.ops) ? a.ops : []
      if (!ops.length) return text('ops 是空的', true)
      return apply(s, ops)
    }
    case 'add_images': {
      const list = Array.isArray(a.images) ? a.images : a.id ? [a] : []
      const p = z.array(AiImage).safeParse(list)
      if (!p.success) return text(z.prettifyError(p.error), true)
      for (const img of p.data) s.images = [...s.images.filter((x) => x.id !== img.id), img]
      return text(`已记下 ${p.data.length} 张图片：${p.data.map((i) => i.id).join('、')}`)
    }
    case 'set_design': {
      // 旧的 set_style、set_design_size 的写法也认
      if (typeof a.style === 'string') s.style = a.style
      const v = size(a.designSize ?? (a.X ? a : undefined))
      if (a.designSize && !v) return text('designSize 的 X、Y 要是正数', true)
      if (v) s.designSize = v
      return text('好了')
    }
    case 'ask_user': {
      const qs = Array.isArray(a.questions) ? a.questions : [a]
      const p = z.array(DesignQuestion).min(1).max(6).safeParse(qs.map(toQuestion))
      if (!p.success) return text(z.prettifyError(p.error), true)
      s.questions = p.data
      return text('已记下，用户回答后会一起交回来。回复一句为什么先问，就结束这一轮。')
    }
    case 'check': {
      const r = checkSession(s)
      return text('error' in r ? r.error : '没有发现问题')
    }
    default:
      return text(`没有这个工具：${raw}`, true)
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
