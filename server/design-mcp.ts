import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AiImage, DesignQuestion, resolveDesignResult, type Design } from '../shared/design.ts'
import { applyOp, type OpsState } from '../shared/design-ops.ts'
import { compactTree } from '../shared/umg.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  contentBox,
  crop,
  decodePng,
  drawGrid,
  encodePng,
  gridStep,
  hasAlpha,
  palette,
  pixelAt,
  resize,
} from './image.ts'
import { imageSize } from './zip.ts'

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
  /** 给 AI 看图用：附件、设计里已有的图，和放生成的预览图的目录 */
  files: DesignFiles
  views: number
}

export interface DesignFiles {
  /** 放预览图的目录（这一轮的工作目录） */
  dir: string
  /** 用户附上的图片 */
  attachments: { name: string; path: string }[]
  /** 设计里已有的图（选中的那一版）的文件路径 */
  imagePath: (id: string) => string | undefined
}

const sessions = new Map<string, Session>()

export function openDesignSession(design: Design, onChange: (s: Session) => void, files: DesignFiles) {
  const token = randomUUID()
  const s: Session = {
    design,
    state: { root: design.root, components: design.components },
    images: [],
    applied: 0,
    onChange,
    files,
    views: 0,
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
const REGION = {
  type: 'object',
  description: '图里的一块，单位是原图像素：左上角 x、y，宽 w、高 h',
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
}
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
    name: 'inspect_image',
    description:
      '量一张图：精确的像素尺寸、宽高比、是否透明、内容范围、主要颜色（十六进制）。region 只量图里的一块，points 取指定位置的颜色。照着参考图做界面时用它取准确的尺寸和颜色，不要目测。' +
      'source 写 "attachment:1"（第几个附件）或 "image:<图片 id>"（设计里已有的图）。',
    inputSchema: obj(
      {
        source: { type: 'string' },
        region: REGION,
        points: { type: 'array', items: obj({ x: { type: 'number' }, y: { type: 'number' } }) },
      },
      ['source'],
    ),
  },
  {
    name: 'view_image',
    description:
      '生成一张方便读数的图：画上坐标格（线上标的是原图像素坐标）、可以放大其中一块，保存成文件，再用你读图的能力看这个文件，按格子读元素的位置和大小，比直接看原图准得多。' +
      '大图先整张看一遍，再用 region 放大细节处（按钮边缘、图标、文字）。source 同 inspect_image；grid 默认画格子；zoom 不写自动放大到合适。',
    inputSchema: obj(
      { source: { type: 'string' }, region: REGION, grid: { type: 'boolean' }, zoom: { type: 'number' } },
      ['source'],
    ),
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

/**
 * 提醒（不算错误，AI 自己判断要不要改）：主界面画布里不拉伸的控件超出了设计稿，
 * 或者图片的显示比例和图片本身差得多（会被拉伸变形）
 */
function warnings(s: Session) {
  const d = s.designSize ?? s.design.designSize
  const root = s.state.root
  if (root.Type !== 'CanvasPanel') return []
  const out: string[] = []
  for (const w of root.Children ?? []) {
    const lay = w.Slot?.LayoutData
    if (!lay || w.Slot?.bAutoSize) continue
    const { Minimum: lo, Maximum: hi } = lay.Anchors ?? {}
    if (!lo || !hi || lo.X !== hi.X || lo.Y !== hi.Y) continue
    const o = lay.Offsets ?? {}
    const width = Number(o.Right)
    const height = Number(o.Bottom)
    if (!(width > 0 && height > 0)) continue
    const x = lo.X * d.X + Number(o.Left) - (lay.Alignment?.X ?? 0) * width
    const y = lo.Y * d.Y + Number(o.Top) - (lay.Alignment?.Y ?? 0) * height
    if (x < -2 || y < -2 || x + width > d.X + 2 || y + height > d.Y + 2)
      out.push(
        `${w.Name} 超出了设计稿 ${d.X}×${d.Y}（位置 ${Math.round(x)},${Math.round(y)}，大小 ${width}×${height}）`,
      )
    const ref = typeof w.Properties?.Brush?.ResourceObject === 'string' ? w.Properties.Brush.ResourceObject : ''
    const im = ref.startsWith('img:') ? [...s.design.images, ...s.images].find((i) => i.id === ref.slice(4)) : undefined
    const nine = w.Properties?.Brush?.DrawAs === 'Box' || w.Properties?.Brush?.DrawAs === 'Border'
    if (im && !nine && Math.abs(width / height / (im.width / im.height) - 1) > 0.15)
      out.push(
        `${w.Name} 显示 ${width}×${height}（比例 ${(width / height).toFixed(2)}），图片 ${im.id} 是 ${im.width}×${im.height}（比例 ${(im.width / im.height).toFixed(2)}），会被拉伸变形：改控件尺寸或图片尺寸让比例一致`,
      )
  }
  return out
}

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

/** 找 source 指的图：附件（从 1 数起，或写文件名）或设计里已有的图 */
function sourceFile(s: Session, source: string): { file: string; name: string; error?: undefined } | { error: string } {
  const m = /^(attachment|image):(.+)$/.exec(source.trim())
  if (!m) return { error: 'source 要写 "attachment:1" 或 "image:<图片 id>"' }
  if (m[1] === 'image') {
    const file = s.files.imagePath(m[2])
    return file ? { file, name: m[2] } : { error: `设计里没有已经生成的图片 ${m[2]}` }
  }
  const list = s.files.attachments
  const at = /^\d+$/.test(m[2]) ? list[Number(m[2]) - 1] : list.find((x) => x.name === m[2])
  return at ? { file: at.path, name: at.name } : { error: `没有这个附件（共 ${list.length} 个）` }
}

/** inspect_image：量；view_image：画格子、放大，存成文件 */
async function inspect(s: Session, view: boolean, a: any) {
  const src = sourceFile(s, str(a.source))
  if (src.error !== undefined) return text(src.error, true)
  const buf = await readFile(src.file).catch(() => undefined)
  if (!buf) return text('读不到这张图', true)
  const info = imageSize(buf)
  const img = decodePng(buf)
  if (!info) return text('不是能识别的图片', true)
  // 不是 PNG：只能告诉尺寸，放大、画格子要自己用读图能力看原文件
  if (!img)
    return text(
      `${src.name}：${info.width}×${info.height} 像素（${info.ext}，这个格式不能放大或取色，请直接读原文件 ${src.file}）`,
    )
  const r = a.region && a.region.w > 0 && a.region.h > 0 ? a.region : undefined
  const rx = Math.max(0, Math.round(r?.x ?? 0))
  const ry = Math.max(0, Math.round(r?.y ?? 0))
  const part = r ? crop(img, rx, ry, r.w, r.h) : img
  const d = s.design.designSize
  // 参考图和设计稿的换算：宽高比不一致时提醒，免得按错的比例算
  const fit =
    Math.abs(info.width / info.height / (d.X / d.Y) - 1) < 0.02
      ? `和设计稿 ${d.X}×${d.Y} 比例一致，原图坐标 × ${(d.X / info.width).toFixed(4)} 就是设计稿坐标`
      : `和设计稿 ${d.X}×${d.Y} 的宽高比不同（${(info.width / info.height).toFixed(3)} 对 ${(d.X / d.Y).toFixed(3)}），换算时按内容要铺满的方式想清楚`
  if (!view) {
    const box = hasAlpha(part) ? contentBox(part) : null
    const pts = (Array.isArray(a.points) ? a.points : []).slice(0, 40).map((p: any) => ({
      x: Math.round(Number(p?.x)),
      y: Math.round(Number(p?.y)),
      color: pixelAt(img, Number(p?.x), Number(p?.y)),
    }))
    return text(
      JSON.stringify({
        name: src.name,
        size: `${info.width}×${info.height}`,
        ...(r ? { region: { x: rx, y: ry, w: part.width, h: part.height } } : {}),
        aspect: Math.round((part.width / part.height) * 1000) / 1000,
        transparent: hasAlpha(part),
        ...(box ? { contentBox: { x: rx + box.x, y: ry + box.y, w: box.w, h: box.h } } : {}),
        palette: palette(part, 8),
        ...(pts.length ? { points: pts } : {}),
        designSizeNote: fit,
      }),
    )
  }
  const long = Math.max(part.width, part.height)
  // 放大到长边约 900 像素（小的块放大看细节，最多 6 倍），整张大图缩到 1600 以内
  const zoom =
    Number(a.zoom) > 0
      ? Math.min(8, Number(a.zoom))
      : r || long < 600
        ? Math.min(6, 900 / long)
        : long > 1800
          ? 1600 / long
          : 1
  let out = zoom === 1 ? part : resize(part, part.width * zoom, part.height * zoom)
  const step = gridStep(long)
  if (a.grid !== false) out = drawGrid(out, { origin: { x: rx, y: ry }, zoom, step })
  await mkdir(path.join(s.files.dir, 'views'), { recursive: true })
  const file = path.join(s.files.dir, 'views', `view-${++s.views}.png`)
  await writeFile(file, encodePng(out))
  return text(
    [
      `已生成 ${file}，用读图的能力看这个文件。`,
      `原图 ${info.width}×${info.height} 像素${r ? `，这张是其中 x ${rx}–${rx + part.width}、y ${ry}–${ry + part.height} 的一块` : ''}，放大 ${Math.round(zoom * 100) / 100} 倍。`,
      a.grid !== false
        ? `品红色格线每格 ${step} 像素，线边的黄色数字是原图像素坐标（横轴数字在上沿，纵轴数字在左沿）。`
        : '',
      fit,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function callTool(s: Session, raw: string, args: any) {
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
    case 'inspect_image':
    case 'view_image':
      return inspect(s, name === 'view_image', a)
    case 'check': {
      const r = checkSession(s)
      const warn = warnings(s)
      const tail = warn.length ? `\n提醒（不一定要改，看是不是故意的）：\n${warn.join('\n')}` : ''
      return text('error' in r ? r.error + tail : `没有发现问题${tail}`)
    }
    default:
      return text(`没有这个工具：${raw}`, true)
  }
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
        serverInfo: { name: 'agent-panel-design', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call':
      return reply(await callTool(s, String(msg.params?.name ?? ''), msg.params?.arguments ?? {}))
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
        const out = Array.isArray(body)
          ? (await Promise.all(body.map((m) => handle(s, m)))).filter(Boolean)
          : await handle(s, body)
        // 只有通知时按协议回 202
        if (!out || (Array.isArray(out) && !out.length)) return c.body(null, 202)
        return c.json(out)
      })
      // 不推送服务端消息：GET 打开事件流的请求按协议回 405
      .get('/design/:token', (c) => c.body(null, 405))
      .delete('/design/:token', (c) => c.body(null, 200))
  )
}
