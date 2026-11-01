import {
  WIDGETS,
  type SlotType,
  allNames,
  cloneWidget,
  deepMerge,
  findParent,
  insertWidget,
  mapWidget,
  moveWidget,
  normalizeTree,
  pathTo,
  removeWidget,
  walk,
  wrapWidget,
  type Component,
  type Widget,
  type WidgetType,
} from './umg.ts'
import { looseAnimation, renameInAnimations, type UiAnimation } from './anim.ts'

/**
 * AI 改设计用的操作：不用每次重写整棵控件树，像在控件树和属性面板里点一样，一步步改：
 * 改属性、加控件、删控件、移动、改名、整个替换，以及子控件（Widget Blueprint）的增删。
 * 控件用名字指定（同一棵树里名字不重复）；in 是在哪个子控件里改，不写就是主界面。
 *
 * 好处：输出短、改得准（不会顺手把没提到的地方改坏），服务端可以边收边应用，页面上实时看到变化。
 */
export type DesignOp =
  | { op: 'set'; in?: string; target: string; path: string; value: unknown }
  | { op: 'add'; in?: string; parent: string; index?: number; widget: unknown }
  | { op: 'remove'; in?: string; target: string }
  | { op: 'move'; in?: string; target: string; parent: string; index?: number }
  | { op: 'rename'; in?: string; target: string; name: string }
  | { op: 'replace'; in?: string; target: string; widget: unknown }
  | { op: 'duplicate'; in?: string; target: string; name?: string; parent?: string; index?: number }
  | { op: 'wrap'; in?: string; target: string; type: string; name?: string }
  | { op: 'addComponent'; component: { Name: string; DesignSize?: { X: number; Y: number }; Root: unknown } }
  | { op: 'removeComponent'; name: string }
  | { op: 'resizeComponent'; name: string; size: { X: number; Y: number } }
  | { op: 'setAnimation'; animation: unknown }
  | { op: 'removeAnimation'; in?: string; name: string }

export interface OpsState {
  root: Widget
  components: Component[]
  /** 动画（见 anim.ts）：in 是属于哪棵树 */
  animations?: UiAnimation[]
}

const byName = (root: Widget, name: string) => {
  let hit: Widget | undefined
  walk(root, (w) => {
    if (w.Name === name) hit = w
  })
  return hit
}

/** 按路径设值：对象和原来的值深合并（只写要改的字段就行），其他直接替换 */
function setPath(obj: any, path: string[], value: unknown): any {
  if (!path.length) {
    if (value && typeof value === 'object' && !Array.isArray(value) && obj && typeof obj === 'object')
      return deepMerge(obj, value)
    return value
  }
  const [k, ...rest] = path
  const base = obj && typeof obj === 'object' ? obj : {}
  return { ...base, [k]: setPath(base[k], rest, value) }
}

// AI 有时把数字写成字符串（"40"、"40px"），也认
const num = (v: unknown, d = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : d
}
const box = (v: unknown) =>
  typeof v === 'number'
    ? { Left: v, Top: v, Right: v, Bottom: v }
    : Array.isArray(v)
      ? v.length === 2
        ? { Left: num(v[0]), Top: num(v[1]), Right: num(v[0]), Bottom: num(v[1]) }
        : { Left: num(v[0]), Top: num(v[1]), Right: num(v[2]), Bottom: num(v[3]) }
      : v
/** 插槽写错了：当场退回给 AI，写明可用的值（以前会悄悄换成默认值，AI 以为改好了） */
export class SlotError extends Error {}

const H_WORDS: Record<string, string> = {
  left: 'Left',
  center: 'Center',
  centre: 'Center',
  middle: 'Center',
  right: 'Right',
  fill: 'Fill',
  stretch: 'Fill',
}
const V_WORDS: Record<string, string> = {
  top: 'Top',
  center: 'Center',
  centre: 'Center',
  middle: 'Center',
  bottom: 'Bottom',
  fill: 'Fill',
  stretch: 'Fill',
}
/** 横排、竖排等插槽的对齐：left / center / right / fill（或 UE 的 HAlign_Left），认不出来直接报错 */
function alignValue(prefix: 'HAlign' | 'VAlign', v: unknown): string {
  const words = prefix === 'HAlign' ? H_WORDS : V_WORDS
  const raw = String(v ?? '').trim()
  const word = raw.replace(/^[HV]Align_/i, '').toLowerCase()
  const hit = words[word]
  if (!hit)
    throw new SlotError(
      `${prefix === 'HAlign' ? '水平对齐 h' : '垂直对齐 v'} 写的是 ${JSON.stringify(v)}，只能是 ${Object.keys(words)
        .filter((k) => !['centre', 'middle', 'stretch'].includes(k))
        .join(' / ')}`,
    )
  return `${prefix}_${hit}`
}

interface AxisSpec {
  /** 锚点：拉伸时两个值不同 */
  min: number
  max: number
}
/**
 * anchor 的写法拆成两个方向：top / bottom / left / right / center 组合（顺序随意，top-center、center-left 都认），
 * stretch 单独写是两个方向都拉伸；stretch-x / top-stretch / bottom-stretch 只横向拉伸，stretch-y / left-stretch / right-stretch 只纵向拉伸。
 * 没提到的方向沿用原来的锚点
 */
function parseAnchor(raw: unknown, prev: { x: AxisSpec; y: AxisSpec }): { x: AxisSpec; y: AxisSpec } {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
  const words = text.split(/[\s_-]+/).filter(Boolean)
  const point = (v: number): AxisSpec => ({ min: v, max: v })
  const STRETCH: AxisSpec = { min: 0, max: 1 }
  let x: AxisSpec | undefined
  let y: AxisSpec | undefined
  let stretch = false
  let axis: 'x' | 'y' | undefined
  let center = 0
  for (const w of words) {
    if (w === 'stretch' || w === 'fill') stretch = true
    else if (w === 'x' || w === 'h' || w === 'horizontal') axis = 'x'
    else if (w === 'y' || w === 'v' || w === 'vertical') axis = 'y'
    else if (w === 'top') y = point(0)
    else if (w === 'bottom') y = point(1)
    else if (w === 'left') x = point(0)
    else if (w === 'right') x = point(1)
    else if (w === 'center' || w === 'centre' || w === 'middle') center++
    else
      throw new SlotError(
        `anchor 写的是 ${JSON.stringify(raw)}，认不出「${w}」。可以写 top-left、top、top-right、left、center、right、bottom-left、bottom、bottom-right，` +
          'stretch（铺满），stretch-x / top-stretch / bottom-stretch（只横向拉伸），stretch-y / left-stretch / right-stretch（只纵向拉伸）',
      )
  }
  if (stretch) {
    // 只拉伸一个方向：stretch-x、或者另一个方向写了位置（top-stretch 横向拉伸、left-stretch 纵向拉伸）
    const only = axis ?? (y && !x ? 'x' : x && !y ? 'y' : undefined)
    if (only === 'x') return { x: STRETCH, y: y ?? (prev.y.min === prev.y.max ? prev.y : point(0)) }
    if (only === 'y') return { x: x ?? (prev.x.min === prev.x.max ? prev.x : point(0)), y: STRETCH }
    return { x: STRETCH, y: STRETCH }
  }
  // center 填没写的方向：单写 center 是两个方向都居中，top-center 是横向居中
  if (center) {
    x ??= point(0.5)
    y ??= point(0.5)
  }
  if (!x && !y) throw new SlotError(`anchor 是空的`)
  return { x: x ?? prev.x, y: y ?? prev.y }
}

/**
 * 画布插槽的简写换成 LayoutData。两个方向分开算，只改写到的：
 * - 不拉伸的方向：x / y 是离锚点的距离，w / h 是宽高；写了 anchor 时对齐点跟锚点走（右下角写 x:-24 就是离右下角 24），
 *   没写 anchor 时对齐点保持原样（以前会被重置成锚点那个角，控件挪半个身位）
 * - 拉伸的方向：x / y 改起始边距，margin 改两边的边距；w / h 在拉伸方向上没有意义，报错让 AI 先换锚点
 * - 只换锚点没写位置：贴到新锚点上（位置清零），宽高沿用
 */
function canvasLayout(out: any, was: any) {
  const wMin = was?.Anchors?.Minimum ?? { X: 0, Y: 0 }
  const wMax = was?.Anchors?.Maximum ?? wMin
  const wAl = was?.Alignment ?? { X: 0, Y: 0 }
  const o = was?.Offsets ?? {}
  const fresh = !was
  const prev = {
    x: { min: num(wMin.X), max: num(wMax.X) },
    y: { min: num(wMin.Y), max: num(wMax.Y) },
  }
  const anchored = out.anchor !== undefined
  const next = anchored ? parseAnchor(out.anchor, prev) : prev
  const m = out.margin !== undefined ? (box(out.margin) as any) : undefined
  const axis = (k: 'X' | 'Y') => {
    const lo = k === 'X' ? 'Left' : 'Top'
    const hi = k === 'X' ? 'Right' : 'Bottom'
    const pos = k === 'X' ? 'x' : 'y'
    const len = k === 'X' ? 'w' : 'h'
    const spec = k === 'X' ? next.x : next.y
    const old = k === 'X' ? prev.x : prev.y
    const wasStretch = old.min !== old.max
    const changed = anchored && (spec.min !== old.min || spec.max !== old.max)
    if (spec.min !== spec.max) {
      if (len in out)
        throw new SlotError(
          `${k === 'X' ? '横' : '纵'}向是拉伸的，${len === 'w' ? '宽' : '高'}度由两边的边距决定：要固定${len === 'w' ? '宽' : '高'}度先把 anchor 换成不拉伸的（例如 ${k === 'X' ? 'top-left' : 'top-left'}），要改边距写 margin`,
        )
      const keep = wasStretch && !changed
      return {
        min: spec.min,
        max: spec.max,
        al: 0,
        start: m ? num(m[lo]) : pos in out ? num(out[pos]) : keep ? num(o[lo]) : 0,
        end: m ? num(m[hi]) : keep ? num(o[hi]) : 0,
      }
    }
    // 不拉伸：对齐点写了 anchor 时跟锚点走，否则沿用
    const al = anchored ? spec.min : fresh ? 0 : num(wAl[k])
    const keepPos = !changed && !wasStretch && !fresh
    const keepLen = !wasStretch && !fresh
    return {
      min: spec.min,
      max: spec.max,
      al,
      start: pos in out ? num(out[pos]) : keepPos ? num(o[lo]) : 0,
      end: len in out ? num(out[len]) : keepLen ? num(o[hi], k === 'X' ? 100 : 40) : k === 'X' ? 100 : 40,
    }
  }
  const x = axis('X')
  const y = axis('Y')
  return {
    Anchors: { Minimum: { X: x.min, Y: y.min }, Maximum: { X: x.max, Y: y.max } },
    Alignment: { X: x.al, Y: y.al },
    Offsets: { Left: x.start, Top: y.start, Right: x.end, Bottom: y.end },
  }
}

/** 画布插槽简写的键：大小写和常见别名都认 */
const CANVAS_KEYS: Record<string, string> = {
  anchor: 'anchor',
  x: 'x',
  y: 'y',
  w: 'w',
  h: 'h',
  z: 'z',
  margin: 'margin',
  width: 'w',
  height: 'h',
  left: 'x',
  top: 'y',
  zorder: 'z',
  margins: 'margin',
  pos: 'pos',
  position: 'pos',
  size: 'size',
}
const SHORT = ['anchor', 'x', 'y', 'w', 'h', 'z', 'margin']

/**
 * 插槽的简写，写起来短、不容易错：
 * 画布里 {"anchor":"top-right","x":-24,"y":24,"w":200,"h":60}——锚点和自身对齐点都是右上角，x、y 是离那个角的距离；
 * {"anchor":"stretch","margin":[左,上,右,下]} 铺满父控件留边距。
 * 横排、竖排等 {"padding":8 或 [左,上,右,下],"fill":1,"h":"center","v":"center"}
 */
function looseSlot(slot: any, parentSlot: SlotType | undefined, prev?: any): any {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return slot
  const out: any = { ...slot }
  if (parentSlot === 'CanvasPanelSlot') {
    // 键名大小写、别名都认（X、Width、left、size:[w,h]…）：认不出来就会悄悄变成默认的 100×40
    for (const [k, v] of Object.entries(slot)) {
      const key = CANVAS_KEYS[k.toLowerCase()]
      if (!key || k === key) continue
      delete out[k]
      if (out[key] === undefined) out[key] = v
    }
    // pos:[x,y]、size:[w,h]（也可以是 {x,y}）
    for (const key of ['pos', 'size'] as const) {
      if (out[key] === undefined) continue
      const v = out[key]
      delete out[key]
      const [a, b] = Array.isArray(v) ? v : [v?.x ?? v?.X, v?.y ?? v?.Y]
      const [ka, kb] = key === 'pos' ? ['x', 'y'] : ['w', 'h']
      if (a !== undefined && out[ka] === undefined) out[ka] = a
      if (b !== undefined && out[kb] === undefined) out[kb] = b
    }
  }
  if (parentSlot === 'CanvasPanelSlot' && SHORT.some((k) => k in out)) {
    out.LayoutData = canvasLayout(out, prev?.LayoutData)
    // 写了宽高就是固定大小：原来是 Size To Content 的要关掉，否则宽高写进去也不生效
    if (('w' in out || 'h' in out) && prev?.bAutoSize && !('bAutoSize' in slot)) out.bAutoSize = false
    if ('z' in out) out.ZOrder = num(out.z)
    for (const k of SHORT) delete out[k]
    return out
  }
  // 画布以外的插槽没有位置和宽高：w、x、y 写进来不会生效，h 还会被当成水平对齐
  if (parentSlot && parentSlot !== 'CanvasPanelSlot') {
    const pos = ['x', 'y', 'w', 'width', 'height', 'anchor', 'margin'].filter((k) => k in out)
    if (pos.length || (typeof out.h === 'number' && 'h' in out))
      throw new SlotError(
        `${parentSlot} 里的控件没有位置和宽高（${[...pos, ...(typeof out.h === 'number' ? ['h'] : [])].join('、')}）：大小由内容决定，固定大小外面套 SizeBox；插槽只写 padding、fill、h（水平对齐 left/center/right/fill）、v（垂直对齐 top/center/bottom/fill）`,
      )
  }
  if ('padding' in out) out.Padding = box(out.padding)
  if ('Padding' in out) out.Padding = box(out.Padding)
  if ('fill' in out) {
    const f = out.fill
    // fill: true / 正数是按比例撑满；false、0、"auto" 是按内容（Automatic）
    const auto = f === false || f === 0 || f === '0' || (typeof f === 'string' && /^auto/i.test(f))
    out.Size = auto ? { SizeRule: 'Automatic', Value: 1 } : { SizeRule: 'Fill', Value: f === true ? 1 : num(f, 1) || 1 }
  }
  if ('h' in out) out.HorizontalAlignment = out.h
  if ('v' in out) out.VerticalAlignment = out.v
  if (out.HorizontalAlignment !== undefined) out.HorizontalAlignment = alignValue('HAlign', out.HorizontalAlignment)
  if (out.VerticalAlignment !== undefined) out.VerticalAlignment = alignValue('VAlign', out.VerticalAlignment)
  for (const k of ['padding', 'fill', 'h', 'v']) delete out[k]
  return out
}

const KEYS: Record<string, string> = {
  type: 'Type',
  name: 'Name',
  slot: 'Slot',
  children: 'Children',
  properties: 'Properties',
  props: 'Properties',
  class: 'Class',
}

/**
 * AI 写的控件宽松一点也认：键名大小写随意（type、children…），Type、Name、Slot、Children、Class 以外的键都当作属性
 * （{"Type":"TextBlock","Name":"Txt_Title","Text":"背包"}），插槽可以用简写（见 looseSlot）。少写错、少返工
 */
export function looseWidget(w: any, parentSlot?: SlotType, prevSlot?: any): any {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return w
  const out: any = { Properties: {} }
  for (const [k, v] of Object.entries(w)) {
    const key = KEYS[k.toLowerCase()] ?? k
    if (key === 'Properties' && v && typeof v === 'object') Object.assign(out.Properties, v)
    else if (['Type', 'Name', 'Slot', 'Children', 'Class', 'id'].includes(key)) out[key] = v
    else out.Properties[key] = v
  }
  const def = WIDGETS[out.Type as keyof typeof WIDGETS]
  // 画布里的位置写在了控件上而不是 Slot 里（{"Type":"Image","x":40,"y":32,"w":320,"h":72}）：挪进 Slot
  if (parentSlot === 'CanvasPanelSlot') {
    for (const k of ['anchor', 'x', 'y', 'w', 'h', 'margin']) {
      if (!(k in out.Properties)) continue
      out.Slot = { ...(out.Slot && typeof out.Slot === 'object' ? out.Slot : {}), [k]: out.Properties[k] }
      delete out.Properties[k]
    }
  }
  out.Slot = looseSlot(out.Slot, parentSlot, prevSlot)
  if (Array.isArray(out.Children)) out.Children = out.Children.map((c: any) => looseWidget(c, def?.slot))
  return out
}

/** 新加的控件里写错的地方：不认识的类型、列表控件下预先放的子控件（normalizeTree 会悄悄换掉或丢掉，先告诉 AI） */
function badWidgets(w: any, out: string[] = []): string[] {
  if (w && typeof w === 'object') {
    if (w.Type && !WIDGETS[w.Type as keyof typeof WIDGETS]) out.push(`未知的控件类型 ${w.Type}（${w.Name ?? ''}）`)
    else if (WIDGETS[w.Type as keyof typeof WIDGETS]?.entries && Array.isArray(w.Children) && w.Children.length)
      out.push(
        `${w.Type} 的条目是运行时生成的，不能预先放子控件（${w.Name ?? ''}）：把条目做成子控件，写在 Properties.EntryWidgetClass 里`,
      )
    for (const c of Array.isArray(w.Children) ? w.Children : []) badWidgets(c, out)
  }
  return out
}

const subtreeNames = (w: any, out: string[] = []) => {
  if (w && typeof w === 'object') {
    if (w.Name) out.push(String(w.Name))
    for (const c of Array.isArray(w.Children) ? w.Children : []) subtreeNames(c, out)
  }
  return out
}

/**
 * 应用一个操作；不合法时返回错误（写给 AI 看的），状态不变。
 * 加进来的控件用 normalizeTree 补齐默认属性和插槽，名字不能和树里已有的重复
 */
export function applyOp(s: OpsState, raw: unknown): { state: OpsState } | { error: string } {
  try {
    return applyOpInner(s, raw)
  } catch (e) {
    // 插槽写错（认不出的锚点、对齐、拉伸方向写了宽高……）：当场退回，不再悄悄换成默认值
    if (e instanceof SlotError) return { error: e.message }
    throw e
  }
}

function applyOpInner(s: OpsState, raw: unknown): { state: OpsState } | { error: string } {
  const op = { ...(raw as any) } as DesignOp
  if (!op || typeof op !== 'object' || typeof (op as any).op !== 'string') return { error: '操作要写成 {"op": …}' }
  const comps = s.components
  if (op.op === 'addComponent' && op.component) op.component = { ...op.component, Root: looseWidget(op.component.Root) }
  const bad = badWidgets(op.op === 'addComponent' ? op.component?.Root : undefined)
  if (bad.length) return { error: bad.join('；') }
  if (op.op === 'addComponent') {
    const c = op.component
    if (!c?.Name) return { error: 'addComponent 要写 component.Name' }
    if (comps.some((x) => x.Name === c.Name))
      return { error: `已经有子控件 ${c.Name}，要改它的内容用 "in":"${c.Name}"` }
    return {
      state: {
        ...s,
        components: [
          ...comps,
          {
            Name: c.Name,
            DesignSize:
              Number(c.DesignSize?.X) > 0 && Number(c.DesignSize?.Y) > 0
                ? { X: Number(c.DesignSize!.X), Y: Number(c.DesignSize!.Y) }
                : { X: 128, Y: 128 },
            Root: normalizeTree(c.Root),
          },
        ],
      },
    }
  }
  if (op.op === 'removeComponent') {
    if (!comps.some((x) => x.Name === op.name)) return { error: `没有子控件 ${op.name}` }
    // 子控件的动画跟着删
    return {
      state: {
        ...s,
        components: comps.filter((x) => x.Name !== op.name),
        ...(s.animations ? { animations: s.animations.filter((a) => a.in !== op.name) } : {}),
      },
    }
  }
  if (op.op === 'setAnimation') {
    // 同一棵树里同名的动画整个换掉
    const r = looseAnimation(op.animation)
    if ('error' in r) return r
    const a = r.animation
    if (a.in && !comps.some((x) => x.Name === a.in)) return { error: `没有子控件 ${a.in}（in 写子控件名，主界面不写）` }
    const tree = a.in ? comps.find((x) => x.Name === a.in)!.Root : s.root
    const names = allNames(tree)
    const missing = [...new Set(a.tracks.map((t) => t.widget).filter((w) => !names.has(w)))]
    if (missing.length)
      return { error: `${a.in ? `子控件 ${a.in} 里` : '主界面里'}没有这些控件：${missing.join('、')}` }
    if (a.source && !names.has(a.source)) return { error: `触发控件 ${a.source} 不存在` }
    const list = s.animations ?? []
    const i = list.findIndex((x) => x.in === a.in && x.name === a.name)
    return { state: { ...s, animations: i >= 0 ? list.map((x, k) => (k === i ? a : x)) : [...list, a] } }
  }
  if (op.op === 'removeAnimation') {
    const list = s.animations ?? []
    const where = op.in ?? ''
    if (!list.some((x) => x.in === where && x.name === op.name))
      return { error: `${where ? `子控件 ${where} 里` : ''}没有动画 ${op.name}` }
    return { state: { ...s, animations: list.filter((x) => !(x.in === where && x.name === op.name)) } }
  }
  if (op.op === 'resizeComponent') {
    if (!comps.some((x) => x.Name === op.name)) return { error: `没有子控件 ${op.name}` }
    // 数字可能写成字符串（"200"）：存成字符串的话下次启动整个设计校验不过、从列表里消失
    const size = { X: Number(op.size?.X), Y: Number(op.size?.Y) }
    if (!(size.X > 0 && size.Y > 0)) return { error: 'resizeComponent 的 size 要写 {"X":宽,"Y":高}，都是正数' }
    return {
      state: { ...s, components: comps.map((x) => (x.Name === op.name ? { ...x, DesignSize: size } : x)) },
    }
  }

  // 下面的操作都在一棵树里：主界面或某个子控件
  const where = 'in' in op && op.in ? op.in : ''
  const comp = where ? comps.find((x) => x.Name === where) : undefined
  if (where && !comp) return { error: `没有子控件 ${where}（in 写子控件名，主界面不写 in）` }
  const root = comp ? comp.Root : s.root
  const done = (next: Widget): { state: OpsState } => ({
    state: comp
      ? { ...s, components: comps.map((x) => (x === comp ? { ...x, Root: next } : x)) }
      : { ...s, root: next },
  })
  const inTree = where ? `子控件 ${where} 里` : '主界面里'
  const need = (name: string | undefined) => {
    const w = name ? byName(root, name) : undefined
    return w ?? `${inTree}没有叫 ${name ?? '（空）'} 的控件`
  }

  switch (op.op) {
    case 'set': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const parts = String(op.path ?? '')
        .split('.')
        .filter(Boolean)
      const [head, ...rest] = parts
      // 只写 Properties / Slot 时值是对象，和原来的深合并（工具 update_widget 用）
      const whole = !rest.length && !!op.value && typeof op.value === 'object' && !Array.isArray(op.value)
      if (head === 'Properties' && (rest.length || whole))
        return done(mapWidget(root, w.id, (x) => setPath(x, parts, op.value)))
      if (head === 'Slot' && (rest.length || whole)) {
        if (!w.Slot) return { error: `${w.Name} 是根控件，没有插槽` }
        const parent = findParent(root, w.id)
        const value = whole ? looseSlot(op.value, parent ? WIDGETS[parent.Type].slot : undefined, w.Slot) : op.value
        return done(mapWidget(root, w.id, (x) => setPath(x, parts, value)))
      }
      if (head === 'Class' && w.Type === 'UserWidget')
        return done(mapWidget(root, w.id, (x) => ({ ...x, Class: String(op.value ?? '') })))
      return { error: `set 的 path 要以 Properties. 或 Slot. 开头，例如 "Properties.Text"（${op.target}）` }
    }
    case 'add': {
      const p = need(op.parent)
      if (typeof p === 'string') return { error: p }
      const def = WIDGETS[p.Type]
      if (!def?.slot) return { error: `${p.Type} 不能放子控件（${p.Name}）` }
      const widget = looseWidget(op.widget, def.slot)
      const wrong = badWidgets(widget)
      if (wrong.length) return { error: wrong.join('；') }
      const names = allNames(root)
      const dup = subtreeNames(widget).find((n) => names.has(n))
      if (dup) return { error: `${inTree}已经有叫 ${dup} 的控件，换个名字` }
      const w = normalizeTree(widget, def.slot, new Set(names))
      return done(insertWidget(root, p.id, w, typeof op.index === 'number' ? op.index : undefined))
    }
    case 'remove': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      if (w.id === root.id) return { error: '不能删根控件，要换掉整个界面用 replace' }
      return done(removeWidget(root, w.id))
    }
    case 'move': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const p = need(op.parent)
      if (typeof p === 'string') return { error: p }
      if (w.id === root.id || pathTo(root, p.id).some((x) => x.id === w.id))
        return { error: `不能把 ${w.Name} 移到它自己里面` }
      if (!WIDGETS[p.Type]?.slot) return { error: `${p.Type} 不能放子控件（${p.Name}）` }
      return done(moveWidget(root, w.id, p.id, typeof op.index === 'number' ? op.index : undefined))
    }
    case 'rename': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const name = String(op.name ?? '')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { error: `控件名要用英文、数字和下划线：${name}` }
      if (name !== w.Name && allNames(root).has(name)) return { error: `${inTree}已经有叫 ${name} 的控件` }
      const r = done(mapWidget(root, w.id, (x) => ({ ...x, Name: name })))
      // 动画里引用这个控件的轨道跟着改名
      if (s.animations) r.state.animations = renameInAnimations(s.animations, where, w.Name, name)
      return r
    }
    case 'replace': {
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const parent = findParent(root, w.id)
      // 只写了一部分插槽（例如 Slot:{"x":20}）：和原来的插槽合并，没写的沿用
      const raw = looseWidget(op.widget, parent ? WIDGETS[parent.Type].slot : undefined, w.Slot)
      if (raw?.Slot && w.Slot) raw.Slot = { ...w.Slot, ...raw.Slot }
      const wrong = badWidgets(raw)
      if (wrong.length) return { error: wrong.join('；') }
      const names = allNames(root)
      // 被替换的这棵子树的名字可以重新用
      walk(w, (x) => names.delete(x.Name))
      const dup = subtreeNames(raw).find((n) => names.has(n))
      if (dup) return { error: `${inTree}已经有叫 ${dup} 的控件，换个名字` }
      const next = normalizeTree(
        { ...raw, Slot: raw?.Slot ?? w.Slot },
        parent ? WIDGETS[parent.Type].slot : undefined,
        new Set(names),
      )
      return done(w.id === root.id ? next : mapWidget(root, w.id, () => next))
    }
    case 'duplicate': {
      // 复制一份（连同子控件）：默认放在原来的后面，名字自动加序号；name 给新的根改名
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      if (w.id === root.id) return { error: '不能复制根控件' }
      const p = op.parent ? need(op.parent) : findParent(root, w.id)
      if (typeof p === 'string') return { error: p }
      if (!p || !WIDGETS[p.Type]?.slot) return { error: `${p?.Name ?? ''} 不能放子控件` }
      if (WIDGETS[p.Type].children === 'one' && p.Children?.length) return { error: `${p.Name} 只能放一个子控件` }
      const names = allNames(root)
      if (op.name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.name))
        return { error: `控件名要用英文、数字和下划线：${op.name}` }
      if (op.name && names.has(op.name)) return { error: `${inTree}已经有叫 ${op.name} 的控件` }
      const c = cloneWidget(w, names)
      if (op.name) c.Name = op.name
      const at =
        typeof op.index === 'number'
          ? op.index
          : p.id === findParent(root, w.id)?.id
            ? p.Children!.findIndex((x) => x.id === w.id) + 1
            : undefined
      return done(insertWidget(root, p.id, c, at))
    }
    case 'wrap': {
      // 外面套一层面板：新面板接过原来的位置和大小
      const w = need(op.target)
      if (typeof w === 'string') return { error: w }
      const type = String(op.type ?? '') as WidgetType
      if (!WIDGETS[type]?.slot)
        return { error: `wrap 的 type 要是能放子控件的面板（例如 Overlay、SizeBox、Border），不能是 ${type}` }
      const names = allNames(root)
      if (op.name && names.has(op.name)) return { error: `${inTree}已经有叫 ${op.name} 的控件` }
      const r = wrapWidget(root, w.id, type, names)
      if (r.root === root) return { error: `${type} 不能用来包裹控件` }
      return done(op.name ? mapWidget(r.root, r.id, (x) => ({ ...x, Name: op.name! })) : r.root)
    }
    default:
      return { error: `不认识的操作 ${(op as any).op}` }
  }
}

/** 依次应用；出错的操作跳过，错误带上序号 */
export function applyOps(s: OpsState, ops: unknown[]): { state: OpsState; errors: string[] } {
  let cur = s
  const errors: string[] = []
  ops.forEach((op, i) => {
    const r = applyOp(cur, op)
    if ('error' in r) errors.push(`ops[${i}]：${r.error}`)
    else cur = r.state
  })
  return { state: cur, errors }
}
